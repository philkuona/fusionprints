/**
 * Image storage service.
 *
 * Handles uploading customer images to Backblaze B2 and retrieving them.
 * Uses the S3-compatible API so we can use the standard AWS SDK.
 *
 * Flow when a customer sends a photo:
 *   1. WhatsApp webhook receives the image
 *   2. We download it from WhatsApp/360dialog
 *   3. We run it through sharp to get real dimensions + validate format
 *   4. We upload it to B2 under a structured key
 *   5. We create a record in the images table
 *   6. We return the image UUID for use in the cart
 *
 * Storage key format: customers/{customerId}/{orderId}/{uuid}.{ext}
 * This makes it easy to find all images for a customer or order.
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { db } from '@/db/client.js';
import { images } from '@/db/schema.js';
import { eq } from 'drizzle-orm';

// ===== S3 client (Backblaze B2 compatible) =====

const s3 = new S3Client({
  endpoint: `https://${env.B2_ENDPOINT}`,
  region: 'auto',
  credentials: {
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
  },
});

// ===== Types =====

export interface StoredImage {
  /** UUID of the image record in the database */
  imageId: string;
  /** Full URL to the image in B2 */
  storageUrl: string;
  /** Storage key within the bucket */
  storageKey: string;
  /** Image dimensions */
  widthPx: number;
  heightPx: number;
  /** File size in bytes */
  fileSizeBytes: number;
  /** MIME type */
  format: string;
  /** Whether WhatsApp compressed this image */
  wasCompressed: boolean;
}

export interface ImageValidationResult {
  valid: boolean;
  widthPx: number;
  heightPx: number;
  fileSizeBytes: number;
  format: string;
  reason?: string;
}

// ===== Core functions =====

/**
 * Validate an image buffer using sharp.
 * Returns dimensions and format, or an error reason.
 */
export async function validateImageBuffer(
  buffer: Buffer,
): Promise<ImageValidationResult> {
  try {
    const metadata = await sharp(buffer).metadata();

    if (!metadata.width || !metadata.height) {
      return {
        valid: false,
        widthPx: 0,
        heightPx: 0,
        fileSizeBytes: buffer.length,
        format: 'unknown',
        reason: 'Could not read image dimensions',
      };
    }

    // Reject non-image formats
    const supportedFormats = ['jpeg', 'png', 'tiff', 'webp', 'heif'];
    if (!metadata.format || !supportedFormats.includes(metadata.format)) {
      return {
        valid: false,
        widthPx: metadata.width,
        heightPx: metadata.height,
        fileSizeBytes: buffer.length,
        format: metadata.format ?? 'unknown',
        reason: `Unsupported format: ${metadata.format}. Please send a JPEG or PNG.`,
      };
    }

    return {
      valid: true,
      widthPx: metadata.width,
      heightPx: metadata.height,
      fileSizeBytes: buffer.length,
      format: metadata.format,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to validate image buffer');
    return {
      valid: false,
      widthPx: 0,
      heightPx: 0,
      fileSizeBytes: buffer.length,
      format: 'unknown',
      reason: 'Could not read image file. Please try sending it again.',
    };
  }
}

/**
 * Upload an image buffer to Backblaze B2 and create a database record.
 *
 * @param buffer - the raw image file bytes
 * @param customerId - UUID of the customer
 * @param mimeType - e.g. 'image/jpeg'
 * @param wasCompressed - whether WhatsApp compressed it
 * @param originalFilename - optional original filename
 */
export async function storeImage(
  buffer: Buffer,
  customerId: string,
  mimeType: string,
  wasCompressed: boolean,
  originalFilename?: string,
): Promise<StoredImage | null> {
  try {
    // Validate and get real dimensions from the file
    const validation = await validateImageBuffer(buffer);

    if (!validation.valid) {
      logger.warn({ customerId, reason: validation.reason }, 'Image validation failed');
      return null;
    }

    // Generate a unique storage key
    const imageUuid = randomUUID();
    const ext = mimeType.split('/')[1] ?? 'jpg';
    const storageKey = `customers/${customerId}/${imageUuid}.${ext}`;

    // Upload to B2
    await s3.send(
      new PutObjectCommand({
        Bucket: env.B2_BUCKET_NAME,
        Key: storageKey,
        Body: buffer,
        ContentType: mimeType,
        ContentLength: buffer.length,
        // Store metadata for debugging
        Metadata: {
          customerId,
          wasCompressed: String(wasCompressed),
          originalFilename: originalFilename ?? '',
        },
      }),
    );

    const storageUrl = `https://${env.B2_BUCKET_NAME}.${env.B2_ENDPOINT}/${storageKey}`;

    // Create database record
    const deleteAfter = new Date();
    deleteAfter.setDate(deleteAfter.getDate() + 30); // 30 days retention

    const [imageRecord] = await db
      .insert(images)
      .values({
        customerId,
        storageUrl,
        storageKey,
        originalFilename: originalFilename ?? null,
        widthPx: validation.widthPx,
        heightPx: validation.heightPx,
        fileSizeBytes: validation.fileSizeBytes,
        format: validation.format,
        wasCompressed,
        deleteAfter,
      })
      .returning();

    logger.info(
      {
        imageId: imageRecord.id,
        customerId,
        dimensions: `${validation.widthPx}x${validation.heightPx}`,
        fileSizeBytes: validation.fileSizeBytes,
      },
      'Image stored successfully',
    );

    return {
      imageId: imageRecord.id,
      storageUrl,
      storageKey,
      widthPx: validation.widthPx,
      heightPx: validation.heightPx,
      fileSizeBytes: validation.fileSizeBytes,
      format: validation.format,
      wasCompressed,
    };
  } catch (err) {
    logger.error({ err, customerId }, 'Failed to store image');
    return null;
  }
}

/**
 * Store an image uploaded via the web platform.
 *
 * Differs from the WhatsApp `storeImage` path:
 *   - Owner is a web_users row (customerId stays null)
 *   - Storage key is namespaced under web-users/{webUserId}/
 *   - Retention is 90 days (vs 30 for WhatsApp uploads)
 *   - EXIF orientation is baked into the pixels via sharp `.rotate()`, so the
 *     stored file always renders upright regardless of the camera flag. This
 *     also keeps the stored width/height honest for the low-res check.
 *
 * @param buffer - the raw uploaded file bytes
 * @param webUserId - UUID of the web platform user
 * @param mimeType - e.g. 'image/jpeg'
 * @param originalFilename - optional original filename
 */
export async function storeWebImage(
  buffer: Buffer,
  webUserId: string,
  mimeType: string,
  originalFilename?: string,
): Promise<StoredImage | null> {
  try {
    // Bake EXIF orientation into the pixels and strip the now-redundant
    // orientation flag. `.rotate()` with no args auto-rotates from EXIF.
    let uploadBuffer: Buffer;
    let outputMime = mimeType;
    try {
      const pipeline = sharp(buffer).rotate();
      // Re-encode in the original format where we can, so dims/orientation
      // are finalised. sharp picks the encoder from the input format.
      uploadBuffer = await pipeline.toBuffer();
    } catch {
      // If sharp can't re-encode (rare formats), fall back to the raw bytes —
      // validation below will reject anything truly unreadable.
      uploadBuffer = buffer;
    }

    // Validate and get real (post-rotation) dimensions from the file
    const validation = await validateImageBuffer(uploadBuffer);

    if (!validation.valid) {
      logger.warn({ webUserId, reason: validation.reason }, 'Web image validation failed');
      return null;
    }

    // sharp normalises the encoded format; keep the mime in sync with it.
    outputMime = `image/${validation.format}`;

    // Generate a unique storage key namespaced to the web user
    const imageUuid = randomUUID();
    const ext = validation.format === 'jpeg' ? 'jpg' : validation.format;
    const storageKey = `web-users/${webUserId}/${imageUuid}.${ext}`;

    // Upload to B2
    await s3.send(
      new PutObjectCommand({
        Bucket: env.B2_BUCKET_NAME,
        Key: storageKey,
        Body: uploadBuffer,
        ContentType: outputMime,
        ContentLength: uploadBuffer.length,
        Metadata: {
          webUserId,
          originalFilename: originalFilename ?? '',
        },
      }),
    );

    const storageUrl = `https://${env.B2_BUCKET_NAME}.${env.B2_ENDPOINT}/${storageKey}`;

    // Create database record — 90-day retention for web uploads
    const deleteAfter = new Date();
    deleteAfter.setDate(deleteAfter.getDate() + 90);

    const [imageRecord] = await db
      .insert(images)
      .values({
        webUserId,
        storageUrl,
        storageKey,
        originalFilename: originalFilename ?? null,
        widthPx: validation.widthPx,
        heightPx: validation.heightPx,
        fileSizeBytes: validation.fileSizeBytes,
        format: validation.format,
        wasCompressed: false,
        deleteAfter,
      })
      .returning();

    logger.info(
      {
        imageId: imageRecord.id,
        webUserId,
        dimensions: `${validation.widthPx}x${validation.heightPx}`,
        fileSizeBytes: validation.fileSizeBytes,
      },
      'Web image stored successfully',
    );

    return {
      imageId: imageRecord.id,
      storageUrl,
      storageKey,
      widthPx: validation.widthPx,
      heightPx: validation.heightPx,
      fileSizeBytes: validation.fileSizeBytes,
      format: validation.format,
      wasCompressed: false,
    };
  } catch (err) {
    logger.error({ err, webUserId }, 'Failed to store web image');
    return null;
  }
}

/**
 * Delete an image from B2 and mark it deleted in the database.
 * Called by the cleanup job 30 days after fulfillment.
 */
export async function deleteImage(imageId: string): Promise<void> {
  try {
    // Get the storage key from the database
    const rows = await db
      .select({ storageKey: images.storageKey })
      .from(images)
      .where(eq(images.id, imageId))
      .limit(1);

    if (rows.length === 0) {
      logger.warn({ imageId }, 'Image not found for deletion');
      return;
    }

    const { storageKey } = rows[0];

    // Delete from B2
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env.B2_BUCKET_NAME,
        Key: storageKey,
      }),
    );

    // Remove from database
    await db.delete(images).where(eq(images.id, imageId));

    logger.info({ imageId, storageKey }, 'Image deleted');
  } catch (err) {
    logger.error({ err, imageId }, 'Failed to delete image');
  }
}

/**
 * Generate a presigned GET URL for a stored image.
 *
 * The B2 bucket is private, so raw storage URLs return 401. Customer-facing
 * surfaces (e.g. the web photo library) need a temporary, signed URL the
 * browser — and Next's image optimizer — can fetch without credentials.
 *
 * Default expiry is 24 hours: long enough that a library page stays usable
 * for a session, short enough to bound exposure of a leaked link.
 *
 * @param storageKey - the object key within the bucket
 * @param expiresInSeconds - signature lifetime (default 86400 = 24h, max 7d)
 */
export async function getSignedImageUrl(
  storageKey: string,
  expiresInSeconds = 24 * 60 * 60,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: storageKey }),
    { expiresIn: expiresInSeconds },
  );
}

/**
 * Test the B2 connection by attempting a simple operation.
 * Called on server startup to verify credentials are correct.
 */
export async function testB2Connection(): Promise<boolean> {
  try {
    // Try to upload a tiny test file
    const testKey = `_health/connection-test-${Date.now()}.txt`;
    await s3.send(
      new PutObjectCommand({
        Bucket: env.B2_BUCKET_NAME,
        Key: testKey,
        Body: Buffer.from('ok'),
        ContentType: 'text/plain',
      }),
    );

    // Clean it up immediately
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env.B2_BUCKET_NAME,
        Key: testKey,
      }),
    );

    logger.info('B2 connection test passed');
    return true;
  } catch (err) {
    logger.error({ err }, 'B2 connection test failed');
    return false;
  }
}
