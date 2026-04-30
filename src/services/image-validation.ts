/**
 * Image validation service.
 *
 * Checks whether a customer's uploaded image is good enough to print.
 * Returns structured results so the bot can decide what to say.
 *
 * In the CLI simulator, we fake image metadata.
 * In production, real dimensions come from sharp after downloading from WhatsApp.
 */

import { getProduct } from '@/config/catalog.js';

export type ImageQuality = 'good' | 'warn' | 'bad' | 'compressed';

export interface ImageValidationResult {
  quality: ImageQuality;
  widthPx: number;
  heightPx: number;
  wasCompressed: boolean;
  /** Aspect ratio mismatch: customer's image vs chosen print size */
  aspectMismatch: boolean;
  /** How far off the aspect ratio is (0 = perfect match) */
  aspectDifference: number;
}

/**
 * Validate an image against a chosen print size.
 *
 * @param widthPx - image width in pixels
 * @param heightPx - image height in pixels
 * @param sizeCode - the chosen print size e.g. '4x6'
 * @param wasCompressed - whether WhatsApp compressed it
 */
export function validateImage(
  widthPx: number,
  heightPx: number,
  sizeCode: string,
  wasCompressed: boolean,
): ImageValidationResult {
  const product = getProduct(sizeCode);

  // If we don't recognise the product, pass it through
  if (!product) {
    return {
      quality: 'good',
      widthPx,
      heightPx,
      wasCompressed,
      aspectMismatch: false,
      aspectDifference: 0,
    };
  }

  // Always orient the image the same way as the print for comparison
  const imgLong = Math.max(widthPx, heightPx);
  const imgShort = Math.min(widthPx, heightPx);
  const printLong = Math.max(product.minResolution.width, product.minResolution.height);
  const printShort = Math.min(product.minResolution.width, product.minResolution.height);

  // Check aspect ratio mismatch
  const imgAspect = imgLong / imgShort;
  const printAspect = printLong / printShort;
  const aspectDifference = Math.abs(imgAspect - printAspect);
  // Mismatch if more than 15% off
  const aspectMismatch = aspectDifference / printAspect > 0.15;

  // Compressed image — flag regardless of resolution
  if (wasCompressed) {
    return {
      quality: 'compressed',
      widthPx,
      heightPx,
      wasCompressed,
      aspectMismatch,
      aspectDifference,
    };
  }

  const recLong = Math.max(
    product.recommendedResolution.width,
    product.recommendedResolution.height,
  );
  const recShort = Math.min(
    product.recommendedResolution.width,
    product.recommendedResolution.height,
  );
  const minLong = Math.max(product.minResolution.width, product.minResolution.height);
  const minShort = Math.min(product.minResolution.width, product.minResolution.height);

  // Below minimum — bad
  if (imgLong < minLong || imgShort < minShort) {
    return {
      quality: 'bad',
      widthPx,
      heightPx,
      wasCompressed,
      aspectMismatch,
      aspectDifference,
    };
  }

  // Above minimum but below recommended — warn
  if (imgLong < recLong || imgShort < recShort) {
    return {
      quality: 'warn',
      widthPx,
      heightPx,
      wasCompressed,
      aspectMismatch,
      aspectDifference,
    };
  }

  // All good
  return {
    quality: 'good',
    widthPx,
    heightPx,
    wasCompressed,
    aspectMismatch,
    aspectDifference,
  };
}

/**
 * Detect if an image was likely compressed by WhatsApp.
 *
 * WhatsApp compresses images sent as photos (not documents) to roughly
 * 1600px on the long edge at ~85% JPEG quality. We use a simple heuristic:
 * if the image is smaller than expected for its claimed file size, it was
 * probably compressed. In production this is detected by checking the
 * MIME type and delivery context from the WhatsApp webhook payload.
 *
 * For now this is a placeholder that the real integration will replace.
 */
export function detectCompression(
  widthPx: number,
  heightPx: number,
  mimeType: string,
): boolean {
  // WhatsApp sends compressed images as image/jpeg with small dimensions
  // Documents come through with the original format preserved
  if (mimeType === 'image/jpeg') {
    const longEdge = Math.max(widthPx, heightPx);
    // If long edge is suspiciously close to WhatsApp's compression ceiling
    return longEdge <= 1600;
  }
  return false;
}
