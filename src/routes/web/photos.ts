/**
 * Web platform photo routes — /web/api/photos/*
 *
 * The customer's personal photo library on the web platform. Photos are
 * stored in B2 (90-day retention) and owned by the signed-in web user.
 *
 * POST   /web/api/photos       — upload one photo (multipart, field "file")
 * GET    /web/api/photos       — list the user's photos (newest first)
 * DELETE /web/api/photos/:id   — delete one photo (ownership-checked)
 *
 * Uploads are one-file-per-request: the frontend fans out one request per
 * dropped file so it can show per-file progress (mirrors the WhatsApp bulk
 * upload page). Multipart support is registered by the upload routes; we
 * register it defensively here too in case route load order changes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { images, orderItems, processedImages } from '@/db/schema.js';
import { storeWebImage, deleteImage, getSignedImageUrl } from '@/services/image-storage.js';
import { authenticateWebUser } from '@/utils/web-auth.js';
import { logger } from '@/utils/logger.js';

export async function registerWebPhotoRoutes(app: FastifyInstance): Promise<void> {
  // Multipart may already be registered by the WhatsApp upload routes.
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, {
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB per file
        files: 1, // one file per request
      },
    });
  }

  // GET /web/api/photos — list this user's photos, newest first
  app.get('/web/api/photos', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const rows = await db
      .select({
        id: images.id,
        storageKey: images.storageKey,
        originalFilename: images.originalFilename,
        widthPx: images.widthPx,
        heightPx: images.heightPx,
        fileSizeBytes: images.fileSizeBytes,
        format: images.format,
        uploadedAt: images.uploadedAt,
      })
      .from(images)
      .where(and(eq(images.webUserId, userId), isNull(images.deletedAt)))
      .orderBy(desc(images.uploadedAt));

    // Bucket is private — hand back time-limited signed URLs the browser can load.
    const photos = await Promise.all(
      rows.map(async ({ storageKey, ...rest }) => ({
        ...rest,
        storageUrl: await getSignedImageUrl(storageKey),
      })),
    );

    return reply.send(photos);
  });

  // POST /web/api/photos — upload a single photo
  app.post('/web/api/photos', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    let data;
    try {
      data = await request.file();
    } catch (err) {
      logger.warn({ err, userId }, 'Web photo upload: could not read multipart file');
      return reply.status(400).send({ error: 'invalid_upload' });
    }

    if (!data) {
      return reply.status(400).send({ error: 'no_file', message: 'No file uploaded.' });
    }

    const buffer = await data.toBuffer();

    const stored = await storeWebImage(buffer, userId, data.mimetype, data.filename);

    if (!stored) {
      return reply.status(400).send({
        error: 'invalid_image',
        message: 'That file could not be processed. Please upload a JPEG or PNG.',
      });
    }

    logger.info({ userId, imageId: stored.imageId }, 'Web photo stored');

    // Signed URL so the freshly uploaded photo renders immediately.
    const signedUrl = await getSignedImageUrl(stored.storageKey);

    return reply.status(201).send({
      id: stored.imageId,
      storageUrl: signedUrl,
      widthPx: stored.widthPx,
      heightPx: stored.heightPx,
      fileSizeBytes: stored.fileSizeBytes,
      format: stored.format,
    });
  });

  // DELETE /web/api/photos/:id — delete a photo the user owns
  app.delete('/web/api/photos/:id', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const { id } = request.params as { id: string };

    // Ownership check — only web-owned photos belonging to this user.
    const [owned] = await db
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.id, id), eq(images.webUserId, userId)))
      .limit(1);

    if (!owned) return reply.status(404).send({ error: 'not_found' });

    // If any order references this image — directly, or via a processed render
    // derived from it — soft-delete it (hide from the library, keep the row + B2
    // object + renders) so past-order previews don't break. Otherwise hard-delete.
    const [refByImage] = await db
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.imageId, id))
      .limit(1);
    let referenced = Boolean(refByImage);
    if (!referenced) {
      const [refByRender] = await db
        .select({ id: orderItems.id })
        .from(orderItems)
        .innerJoin(processedImages, eq(orderItems.processedImageId, processedImages.id))
        .where(eq(processedImages.sourceImageId, id))
        .limit(1);
      referenced = Boolean(refByRender);
    }

    if (referenced) {
      await db.update(images).set({ deletedAt: new Date() }).where(eq(images.id, id));
      logger.info({ imageId: id, userId }, 'Photo soft-deleted (referenced by an order)');
    } else {
      await deleteImage(id);
    }

    return reply.send({ success: true });
  });
}
