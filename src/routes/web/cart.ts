/**
 * Web platform cart routes — /web/api/cart
 *
 * Server-backed cart so a logged-in customer can pick up the same cart on
 * another device. One row per user (upserted). The cart is stored as an opaque
 * JSON blob (the web app's CartItem[]); checkout re-validates every item, so the
 * cart itself isn't trusted for pricing/ownership — it only needs to round-trip.
 *
 * GET    /web/api/cart  — the user's saved cart (image URLs re-signed)
 * PUT    /web/api/cart  — replace the user's saved cart
 * DELETE /web/api/cart  — clear it (e.g. after checkout)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, inArray, and } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { webCarts, images, processedImages } from '@/db/schema.js';
import { authenticateWebUser } from '@/utils/web-auth.js';
import { getSignedImageUrl } from '@/services/image-storage.js';
import { logger } from '@/utils/logger.js';

// A cart item is largely opaque (the web app owns its shape), but we validate
// the fields we read for re-signing + keep the payload from growing unbounded.
const cartItemSchema = z
  .object({
    id: z.string().min(1).max(200),
    photoId: z.string().max(100).optional(),
    storageUrl: z.string().max(2000).optional(),
    sizeCode: z.string().max(50),
    label: z.string().max(120).optional(),
    qty: z.number().int().min(1).max(999),
    unitPriceUsd: z.number().min(0).optional(),
    processedImageId: z.string().uuid().optional(),
    processedUrl: z.string().max(2000).optional(),
  })
  .passthrough(); // keep any extra fields (paper, border, layoutPayload, …) intact

const cartSchema = z.object({ items: z.array(cartItemSchema).max(100) });

type CartItem = z.infer<typeof cartItemSchema>;

/**
 * Refresh the (short-lived) signed preview URLs on a stored cart so items still
 * render on a different device days later. Looks up the source/processed images
 * the user owns and re-signs; leaves anything it can't resolve untouched.
 */
async function resignCartUrls(userId: string, items: CartItem[]): Promise<CartItem[]> {
  const photoIds = [...new Set(items.map((i) => i.photoId).filter((x): x is string => !!x))];
  const procIds = [...new Set(items.map((i) => i.processedImageId).filter((x): x is string => !!x))];

  const [imgRows, procRows] = await Promise.all([
    photoIds.length
      ? db
          .select({ id: images.id, storageKey: images.storageKey })
          .from(images)
          .where(and(inArray(images.id, photoIds), eq(images.webUserId, userId)))
      : Promise.resolve([]),
    procIds.length
      ? db
          .select({ id: processedImages.id, storageKey: processedImages.processedStorageKey })
          .from(processedImages)
          .where(and(inArray(processedImages.id, procIds), eq(processedImages.webUserId, userId)))
      : Promise.resolve([]),
  ]);

  const imgKey = new Map(imgRows.map((r) => [r.id, r.storageKey]));
  const procKey = new Map(procRows.map((r) => [r.id, r.storageKey]));

  return Promise.all(
    items.map(async (item) => {
      const next = { ...item };
      const sKey = item.photoId ? imgKey.get(item.photoId) : undefined;
      if (sKey) next.storageUrl = await getSignedImageUrl(sKey);
      const pKey = item.processedImageId ? procKey.get(item.processedImageId) : undefined;
      if (pKey) next.processedUrl = await getSignedImageUrl(pKey);
      return next;
    }),
  );
}

export async function registerWebCartRoutes(app: FastifyInstance): Promise<void> {
  // GET /web/api/cart — the saved cart, with fresh signed preview URLs.
  app.get('/web/api/cart', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const [row] = await db.select().from(webCarts).where(eq(webCarts.webUserId, userId)).limit(1);
    const items = (row?.items as CartItem[] | undefined) ?? [];
    const resigned = await resignCartUrls(userId, items).catch((err) => {
      logger.error({ err, userId }, 'Cart URL re-sign failed; returning stored URLs');
      return items;
    });
    return reply.send({ items: resigned, updatedAt: row?.updatedAt ?? null });
  });

  // PUT /web/api/cart — replace the saved cart (upsert one row per user).
  app.put('/web/api/cart', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const parsed = cartSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_cart', message: 'Cart payload was malformed.' });
    }

    await db
      .insert(webCarts)
      .values({ webUserId: userId, items: parsed.data.items, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: webCarts.webUserId,
        set: { items: parsed.data.items, updatedAt: new Date() },
      });

    return reply.send({ ok: true });
  });

  // DELETE /web/api/cart — clear it (after a successful checkout).
  app.delete('/web/api/cart', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;
    await db.delete(webCarts).where(eq(webCarts.webUserId, userId));
    return reply.send({ ok: true });
  });
}
