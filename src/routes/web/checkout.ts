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
import { eq, and, inArray, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { processedImages, customerAddresses, payments, images } from '@/db/schema.js';
import { getProduct } from '@/config/catalog.js';
import { authenticateWebUser } from '@/utils/web-auth.js';
import { normalizePhone } from '@/utils/phone.js';
import {
  createWebOrder,
  getWebOrderByNumber,
  markOrderPaid,
  type CreateWebOrderItem,
} from '@/services/order.js';
import { initiateWebPayment } from '@/services/web-payment.js';
import { sendOrderReceipt } from '@/services/web-order-email.js';
import { logger } from '@/utils/logger.js';

const compositeLayoutSchema = z.object({
  orientation: z.string().optional(),
  cells: z
    .array(
      z.object({
        cellIndex: z.number().int().min(0),
        imageId: z.string().uuid().nullable(),
        transform: z.unknown().optional(),
        border: z.unknown().nullable().optional(),
      }),
    )
    .min(1),
});

const checkoutSchema = z.object({
  items: z
    .array(
      z
        .object({
          processedImageId: z.string().uuid().optional(),
          sizeCode: z.string().min(1),
          quantity: z.number().int().min(1).max(999),
          paper: z.string().max(20).optional().nullable(),
          // Composite products (wallet/passport/mini) carry a layout instead of
          // a single processed render.
          productType: z.literal('composite').optional(),
          layoutPayload: compositeLayoutSchema.optional(),
        })
        .refine(
          (i) => (i.productType === 'composite' ? !!i.layoutPayload : !!i.processedImageId),
          { message: 'Each item must be edited before checkout.' },
        ),
    )
    .min(1, 'Your cart is empty.'),
  fulfillmentMethod: z.enum(['collection', 'delivery']),
  deliveryZone: z.string().optional(),
  addressId: z.string().uuid().optional().nullable(),
  // Chosen pickup location for collection orders (from GET /web/api/collection-points).
  collectionPointId: z.string().uuid().optional().nullable(),
  // Required: a contact number so we can reach the customer about the order
  // (and send the "ready for pickup" WhatsApp). E.164-ish.
  phone: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{7,14}$/, 'Enter a valid phone number, e.g. +263771234567.'),
  // Required: the buyer's full name, for their QBO customer record + receipt.
  fullName: z.string().trim().min(1, 'Enter your full name.').max(120),
  // Optional gift recipient (R2-13): notify them alongside the buyer. Name is
  // for the records; the number drives the WhatsApp notice.
  recipientName: z.string().trim().max(120).optional().nullable(),
  recipientPhone: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{7,14}$/, 'Enter a valid recipient phone number.')
    .optional()
    .nullable(),
  // Optional billing address (card payments) when it differs from delivery.
  billingAddress: z.string().trim().max(400).optional().nullable(),
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
    const { items, fulfillmentMethod, addressId, phone, fullName, collectionPointId, recipientName, recipientPhone, billingAddress } = parsed.data;
    // Store the contact number in E.164 (any country, default Zimbabwe) so
    // WhatsApp notifications work for local and international customers alike.
    const contactPhone = normalizePhone(phone) ?? phone;
    // Gift recipient (R2-13): normalise their number too so notify-both works.
    const recipientPhoneE164 = recipientPhone ? (normalizePhone(recipientPhone) ?? recipientPhone) : null;

    const standardItems = items.filter((i) => i.productType !== 'composite');
    const compositeItems = items.filter((i) => i.productType === 'composite');

    // Standard items: verify each processed render belongs to this user + size matches.
    const procIds = [...new Set(standardItems.map((i) => i.processedImageId!))];
    const owned = procIds.length
      ? await db
          .select({
            id: processedImages.id,
            sourceImageId: processedImages.sourceImageId,
            sizeCode: processedImages.sizeCode,
          })
          .from(processedImages)
          .where(and(inArray(processedImages.id, procIds), eq(processedImages.webUserId, userId)))
      : [];
    const ownedById = new Map(owned.map((o) => [o.id, o]));

    for (const item of standardItems) {
      const o = ownedById.get(item.processedImageId!);
      if (!o) {
        return reply.status(400).send({ error: 'invalid_image', message: 'An item is missing its edited render.' });
      }
      if (o.sizeCode !== item.sizeCode) {
        return reply.status(400).send({ error: 'size_mismatch', message: 'An item size no longer matches its edit.' });
      }
    }

    // Composite items: sizeCode must be a real composite product, and every
    // cell's photo must belong to this user.
    if (compositeItems.length > 0) {
      for (const item of compositeItems) {
        const product = getProduct(item.sizeCode);
        if (!product || product.productType !== 'composite') {
          return reply.status(400).send({ error: 'invalid_product', message: 'Unknown composite product.' });
        }
      }
      const cellImageIds = [
        ...new Set(
          compositeItems.flatMap((i) =>
            (i.layoutPayload?.cells ?? []).map((c) => c.imageId).filter((x): x is string => !!x),
          ),
        ),
      ];
      const ownedImgs = cellImageIds.length
        ? await db
            .select({ id: images.id })
            .from(images)
            .where(and(inArray(images.id, cellImageIds), eq(images.webUserId, userId)))
        : [];
      const ownedImgSet = new Set(ownedImgs.map((r) => r.id));
      for (const item of compositeItems) {
        for (const c of item.layoutPayload?.cells ?? []) {
          if (!c.imageId || !ownedImgSet.has(c.imageId)) {
            return reply.status(400).send({ error: 'invalid_image', message: 'A composite cell is missing its photo.' });
          }
        }
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

    // Preserve original order — createWebOrder maps quote.items back by index.
    const orderItemsInput: CreateWebOrderItem[] = items.map((i) =>
      i.productType === 'composite'
        ? {
            productType: 'composite' as const,
            sizeCode: i.sizeCode,
            quantity: i.quantity,
            layoutPayload: i.layoutPayload,
            // order_items.imageId carries the first cell's photo for previews.
            sourceImageId: i.layoutPayload?.cells?.[0]?.imageId ?? null,
            processedImageId: null,
          }
        : {
            processedImageId: i.processedImageId!,
            sourceImageId: ownedById.get(i.processedImageId!)?.sourceImageId ?? null,
            sizeCode: i.sizeCode,
            quantity: i.quantity,
            paper: i.paper ?? null,
          },
    );

    const res = await createWebOrder({
      webUserId: userId,
      items: orderItemsInput,
      fulfillmentMethod,
      deliveryZone,
      deliveryAddress,
      collectionPointId: fulfillmentMethod === 'collection' ? collectionPointId ?? null : null,
      contactPhone,
      contactName: fullName,
      recipientName: recipientName ?? null,
      recipientPhone: recipientPhoneE164,
      billingAddress: billingAddress ?? null,
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
      // Real method (ecocash/card) is known only once Payonify reports it.
      paymentMethod: init.provider === 'virtual' ? 'virtual' : null,
    });

    logger.info({ orderNumber: res.orderNumber, userId, provider: init.provider }, 'Web checkout created order (pending payment)');
    return reply.send({
      orderNumber: res.orderNumber,
      reference: init.reference,
      status: 'pending',
      totalUsd: res.order.totalUsd,
      provider: init.provider,
      // Present for embedded gateways (Payonify) — the browser mounts the
      // Drop-In with this. Absent for the virtual/mock provider.
      clientSecret: init.clientSecret ?? null,
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

    // SECURITY: this mock confirm is ONLY for the service-virtualised provider.
    // Real-gateway orders (Payonify) are marked paid solely by the signed
    // webhook — otherwise a customer could mark their own order paid for free.
    const [pay] = await db
      .select({ provider: payments.provider })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.initiatedAt))
      .limit(1);
    if (pay && pay.provider !== 'virtual') {
      return reply.status(409).send({ error: 'not_applicable', message: 'This order is paid through the payment gateway.' });
    }

    if (parsed.data.outcome === 'success') {
      // Idempotent: only act if not already paid.
      if (order.status === 'pending_payment') {
        await db
          .update(payments)
          .set({ status: 'success', completedAt: new Date() })
          .where(eq(payments.orderId, order.id));
        await markOrderPaid(order.orderNumber, `VIRT-${order.orderNumber}`);
        // Branded receipt email — best effort, never blocks the response.
        await sendOrderReceipt(order.orderNumber).catch((err: unknown) => {
          logger.error({ err, orderNumber: order.orderNumber }, 'Order receipt email failed');
        });
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
