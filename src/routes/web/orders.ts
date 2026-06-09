/**
 * Web order routes — /web/api/orders/*
 *
 * GET /web/api/orders               — the signed-in user's orders (newest first)
 * GET /web/api/orders/:orderNumber  — one order (ownership-checked) + line items
 *
 * Powers the web order history + tracking pages.
 */

import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orderItems, processedImages, payments } from '@/db/schema.js';
import { authenticateWebUser } from '@/utils/web-auth.js';
import { getWebUserOrders, getWebOrderByNumber } from '@/services/order.js';
import { getSignedImageUrl } from '@/services/image-storage.js';
import { getProduct } from '@/config/catalog.js';

export async function registerWebOrderRoutes(app: FastifyInstance): Promise<void> {
  // GET /web/api/orders
  app.get('/web/api/orders', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const orders = await getWebUserOrders(userId);

    // Attach a print count + a first-item thumbnail per order for the list.
    const summaries = await Promise.all(
      orders.map(async (o) => {
        const items = await db
          .select({
            quantity: orderItems.quantity,
            processedKey: processedImages.processedStorageKey,
          })
          .from(orderItems)
          .leftJoin(processedImages, eq(orderItems.processedImageId, processedImages.id))
          .where(eq(orderItems.orderId, o.id));

        const prints = items.reduce((n, it) => n + it.quantity, 0);
        const firstKey = items.find((it) => it.processedKey)?.processedKey ?? null;
        const thumbnailUrl = firstKey ? await getSignedImageUrl(firstKey) : null;

        return {
          orderNumber: o.orderNumber,
          status: o.status,
          totalUsd: o.totalUsd,
          fulfillmentMethod: o.fulfillmentMethod,
          createdAt: o.createdAt,
          prints,
          thumbnailUrl,
        };
      }),
    );

    return reply.send(summaries);
  });

  // GET /web/api/orders/:orderNumber
  app.get('/web/api/orders/:orderNumber', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const { orderNumber } = request.params as { orderNumber: string };
    const order = await getWebOrderByNumber(userId, orderNumber);
    if (!order) return reply.status(404).send({ error: 'not_found' });

    const rows = await db
      .select({
        sizeCode: orderItems.sizeCode,
        quantity: orderItems.quantity,
        paper: orderItems.paper,
        unitPriceUsd: orderItems.unitPriceUsd,
        lineTotalUsd: orderItems.lineTotalUsd,
        processedKey: processedImages.processedStorageKey,
      })
      .from(orderItems)
      .leftJoin(processedImages, eq(orderItems.processedImageId, processedImages.id))
      .where(eq(orderItems.orderId, order.id));

    const items = await Promise.all(
      rows.map(async (r) => ({
        sizeCode: r.sizeCode,
        label: getProduct(r.sizeCode)?.labelInches ?? r.sizeCode,
        quantity: r.quantity,
        paper: r.paper,
        unitPriceUsd: r.unitPriceUsd,
        lineTotalUsd: r.lineTotalUsd,
        previewUrl: r.processedKey ? await getSignedImageUrl(r.processedKey) : null,
      })),
    );

    // Latest payment status — lets the checkout poll distinguish a failed
    // payment from a still-pending one (so it can stop waiting and show "failed").
    const [pay] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.initiatedAt))
      .limit(1);

    return reply.send({
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: pay?.status ?? null,
      subtotalUsd: order.subtotalUsd,
      deliveryFeeUsd: order.deliveryFeeUsd,
      totalUsd: order.totalUsd,
      fulfillmentMethod: order.fulfillmentMethod,
      deliveryAddress: order.deliveryAddress,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
      readyAt: order.readyAt,
      shippedAt: order.shippedAt,
      fulfilledAt: order.fulfilledAt,
      items,
    });
  });
}
