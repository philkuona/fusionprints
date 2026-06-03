/**
 * Web editor routes — /web/api/editor/*
 *
 * POST /web/api/editor/apply — validate an edit payload, render the print-ready
 *   file with Sharp, store it, and return a signed URL + processed id. Save in
 *   the editor calls this; cart/order attachment (Phase 2.3) reuses the result.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { images } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { authenticateWebUser } from '@/utils/web-auth.js';
import { editPayloadSchema } from '@/schemas/edit-payload.js';
import { PRODUCTS } from '@/config/catalog.js';
import { getImageBuffer, storeProcessedImage } from '@/services/image-storage.js';
import { applyEdit, payloadHash } from '@/services/edit-applier.js';

export async function registerWebEditorRoutes(app: FastifyInstance): Promise<void> {
  app.post('/web/api/editor/apply', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const parsed = editPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', issues: parsed.error.flatten() });
    }
    const payload = parsed.data;

    const product = PRODUCTS.find((p) => p.sizeCode === payload.sizeCode);
    if (!product) return reply.status(400).send({ error: 'unknown_size' });

    // Ownership check — the source image must belong to this web user.
    const [image] = await db
      .select({ storageKey: images.storageKey })
      .from(images)
      .where(and(eq(images.id, payload.sourceImageId), eq(images.webUserId, userId)))
      .limit(1);
    if (!image) return reply.status(404).send({ error: 'not_found' });

    try {
      const buffer = await getImageBuffer(image.storageKey);
      const applied = await applyEdit(buffer, payload, product);
      const stored = await storeProcessedImage({
        buffer: applied.buffer,
        webUserId: userId,
        sourceImageId: payload.sourceImageId,
        sizeCode: payload.sizeCode,
        payloadHash: payloadHash(payload),
        editPayload: payload,
        widthPx: applied.width,
        heightPx: applied.height,
        mimeType: 'image/jpeg',
      });
      if (!stored) return reply.status(500).send({ error: 'store_failed' });

      return reply.send({
        id: stored.id,
        processedUrl: stored.signedUrl,
        width: applied.width,
        height: applied.height,
      });
    } catch (err) {
      logger.error({ err, sourceImageId: payload.sourceImageId }, 'Editor apply failed');
      return reply.status(500).send({ error: 'apply_failed' });
    }
  });
}
