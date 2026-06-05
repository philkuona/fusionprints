/**
 * Web checkout routes — /web/api/checkout/*
 *
 * POST /web/api/checkout                       — create a web order + initiate payment
 * POST /web/api/checkout/:orderNumber/confirm  — confirm/fail payment (virtualised gateway callback)
 *
 * Payment is service-virtualised for now (see services/web-payment.ts): confirm
 * stands in for the real gateway webhook → markOrderPaid → print jobs + slips.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { processedImages, customerAddresses, payments } from '@/db/schema.js';
import { authenticateWebUser } from '@/utils/web-auth.js';
import {
  createWebOrder,
  getWebOrderByNumber,
  markOrderPaid,
  type CreateWebOrderItem,
} from '@/services/order.js';
import { initiateWebPayment } from '@/services/web-payment.js';
import { sendWebOrderConfirmation } from '@/services/web-order-email.js';
import { logger } from '@/utils/logger.js';

const checkoutSchema = z.object({
  items: z
    .array(
      z.object({
        processedImageId: z.string().uuid('Each item must be edited before checkout.'),
        sizeCode: z.string().min(1),
        quantity: z.number().int().min(1).max(999),
        paper: z.string().max(20).optional().nullable(),
      }),
    )
    .min(1, 'Your cart is empty.'),
  fulfillmentMethod: z.enum(['collection', 'delivery']),
  deliveryZone: z.string().optional(),
  addressId: z.string().uuid().optional().nullable(),
});

const confirmSchema = z.object({ outcome: z.enum(['success', 'fail']) });

function formatAddress(a: {
  recipientName: string;
  addressLine1: string;
  suburb: string | null;
  city: string;
  deliveryInstructions: string | null;
}): string {
  return [
    a.recipientName,
    a.addressLine1,
    a.suburb,
    a.city,
    a.deliveryInstructions ? `(${a.deliveryInstructions})` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

export async function registerWebCheckoutRoutes(app: FastifyInstance): Promise<void> {
  // POST /web/api/checkout
  app.post('/web/api/checkout', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const { items, fulfillmentMethod, addressId } = parsed.data;

    // Verify every processed image belongs to this user and matches its size.
    const procIds = [...new Set(items.map((i) => i.processedImageId))];
    const owned = await db
      .select({
        id: processedImages.id,
        sourceImageId: processedImages.sourceImageId,
        sizeCode: processedImages.sizeCode,
      })
      .from(processedImages)
      .where(and(inArray(processedImages.id, procIds), eq(processedImages.webUserId, userId)));
    const ownedById = new Map(owned.map((o) => [o.id, o]));

    for (const item of items) {
      const o = ownedById.get(item.processedImageId);
      if (!o) {
        return reply.status(400).send({ error: 'invalid_image', message: 'An item is missing its edited render.' });
      }
      if (o.sizeCode !== item.sizeCode) {
        return reply.status(400).send({ error: 'size_mismatch', message: 'An item size no longer matches its edit.' });
      }
    }

    // Resolve delivery address (ownership-checked) for delivery orders.
    let deliveryAddress: string | null = null;
    let deliveryZone = 'collection';
    if (fulfillmentMethod === 'delivery') {
      if (!addressId) {
        return reply.status(400).send({ error: 'address_required', message: 'Choose a delivery address.' });
      }
      const [addr] = await db
        .select()
        .from(customerAddresses)
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.webUserId, userId)))
        .limit(1);
      if (!addr) {
        return reply.status(400).send({ error: 'address_not_found', message: 'That address could not be found.' });
      }
      deliveryAddress = formatAddress(addr);
      deliveryZone = parsed.data.deliveryZone ?? 'collection';
    }

    const orderItemsInput: CreateWebOrderItem[] = items.map((i) => ({
      processedImageId: i.processedImageId,
      sourceImageId: ownedById.get(i.processedImageId)?.sourceImageId ?? null,
      sizeCode: i.sizeCode,
      quantity: i.quantity,
      paper: i.paper ?? null,
    }));

    const res = await createWebOrder({
      webUserId: userId,
      items: orderItemsInput,
      fulfillmentMethod,
      deliveryZone,
      deliveryAddress,
    });
    if (!res.ok) {
      return reply.status(400).send({ error: 'order_failed', message: res.reason });
    }

    const init = await initiateWebPayment({
      orderNumber: res.orderNumber,
      amountUsd: Number(res.order.totalUsd),
    });

    await db.insert(payments).values({
      orderId: res.order.id,
      provider: init.provider,
      providerReference: init.reference,
      amountUsd: res.order.totalUsd,
      status: 'pending',
      paymentMethod: 'virtual',
    });

    logger.info({ orderNumber: res.orderNumber, userId }, 'Web checkout created order (pending payment)');
    return reply.send({
      orderNumber: res.orderNumber,
      reference: init.reference,
      status: 'pending',
      totalUsd: res.order.totalUsd,
    });
  });

  // POST /web/api/checkout/:orderNumber/confirm — virtualised gateway callback
  app.post('/web/api/checkout/:orderNumber/confirm', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const { orderNumber } = request.params as { orderNumber: string };
    const parsed = confirmSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error' });
    }

    const order = await getWebOrderByNumber(userId, orderNumber);
    if (!order) return reply.status(404).send({ error: 'not_found' });

    if (parsed.data.outcome === 'success') {
      // Idempotent: only act if not already paid.
      if (order.status === 'pending_payment') {
        await db
          .update(payments)
          .set({ status: 'success', completedAt: new Date() })
          .where(eq(payments.orderId, order.id));
        await markOrderPaid(order.orderNumber, `VIRT-${order.orderNumber}`);
        // Confirmation email — best effort, never blocks the response.
        await sendWebOrderConfirmation(order.orderNumber).catch(() => {});
      }
      return reply.send({ status: 'paid', orderNumber });
    }

    await db
      .update(payments)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(payments.orderId, order.id));
    return reply.send({ status: 'failed', orderNumber });
  });
}
