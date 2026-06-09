/**
 * Payment provider webhooks.
 *
 * Two endpoints:
 *
 *   POST /webhook/payment/ecocash
 *     Magetsi calls this when the customer enters their EcoCash PIN.
 *     We verify the signature, look up the order, mark it paid, release print jobs.
 *
 *   POST /webhook/payment/stripe
 *     Stripe calls this on completed checkout sessions.
 *     We verify with Stripe's signature header, look up the order, mark paid.
 *
 * The bot then sends a confirmation message to the customer via WhatsApp.
 *
 * Both endpoints are stubbed for now — once Magetsi/Stripe API specs are in
 * place we'll fill them in. The shape of this file is the placeholder so
 * the integration can land later without restructuring.
 */

import type { FastifyInstance } from 'fastify';
import { markOrderPaid, getOrderByNumber } from '@/services/order.js';
import { logger } from '@/utils/logger.js';
import { env } from '@/config/env.js';
import { sendWhatsAppMessage } from '@/services/whatsapp.js';
import { db } from '@/db/client.js';
import { customers, orders, orderItems } from '@/db/schema.js';
import { eq } from 'drizzle-orm';
import { MSG } from '@/bot/messages.js';

interface MagetsiCallback {
  reference: string;       // Order number we sent
  status: 'success' | 'failed' | 'cancelled' | 'timeout';
  msisdn: string;          // EcoCash number paid from
  amount_usd: number;
  transaction_id: string;
  // signature check field — TBD with Magetsi spec
}

export async function notifyCustomerOfPayment(orderNumber: string): Promise<void> {
  // Look up the customer to send them a confirmation
  const order = await getOrderByNumber(orderNumber);
  if (!order) return;
  // This is the WhatsApp payment-confirmation path; web orders (no WhatsApp
  // customer) are confirmed via the web channel, not here.
  if (!order.customerId) return;

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, order.customerId))
    .limit(1);
  if (!customer) return;

  // Decide message: posters need approval first, photos go straight to queue
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const hasManualReview = items.some((i) => i.requiresManualReview);

  const message = hasManualReview
    ? MSG.paymentConfirmedPoster(orderNumber)
    : MSG.paymentConfirmed(orderNumber);

  // Strip leading + for WhatsApp E.164 format
  const to = customer.phoneNumber.replace(/^\+/, '');

  try {
    await sendWhatsAppMessage(to, message);
  } catch (err) {
    logger.error({ err, orderNumber }, 'Failed to send payment confirmation');
  }
}

export async function registerPaymentWebhooks(app: FastifyInstance): Promise<void> {

  // ===== EcoCash callback (Magetsi) =====
  app.post('/webhook/payment/ecocash', async (request, reply) => {
    const body = request.body as MagetsiCallback;

    logger.info({ body }, 'EcoCash webhook received');

    // TODO: verify Magetsi signature here once we have the spec.
    // For now we trust the request — fine in dev, NOT fine in production.
    if (env.PAYMENT_PROVIDER === 'magetsi') {
      logger.warn('Magetsi signature verification not implemented — DO NOT use in production yet');
    }

    if (!body || !body.reference) {
      reply.status(400).send({ error: 'Missing reference' });
      return;
    }

    if (body.status === 'success') {
      try {
        await markOrderPaid(body.reference, body.transaction_id ?? body.reference);
        await notifyCustomerOfPayment(body.reference);
        logger.info({ orderNumber: body.reference }, 'EcoCash payment confirmed');
        return { ok: true };
      } catch (err) {
        logger.error({ err, body }, 'Failed to process EcoCash payment');
        reply.status(500).send({ error: 'Failed to process payment' });
        return;
      }
    }

    // Failed/cancelled/timeout — log but don't error
    logger.info({ orderNumber: body.reference, status: body.status }, 'EcoCash payment did not complete');
    return { ok: true, action: 'noted' };
  });

  // ===== Stripe webhook (cards) =====
  app.post('/webhook/payment/stripe', async (request, reply) => {
    logger.info('Stripe webhook received');

    // TODO: verify Stripe signature with stripe.webhooks.constructEvent
    // const sig = request.headers['stripe-signature'];
    // const event = stripe.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);

    // For now stub
    return { ok: true };
  });

  // ===== Manual confirmation endpoint (admin only) =====
  // Used when payment confirmation didn't come through automatically — e.g.
  // customer paid but webhook failed. Admin can manually mark the order paid.
  app.post('/admin/api/ops/orders/:id/mark-paid', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      reply.header('WWW-Authenticate', 'Basic realm="FusionPrints Admin"').status(401).send('Auth required');
      return;
    }
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
    const [, password] = decoded.split(':');
    if (password !== env.ADMIN_PASSWORD) {
      reply.status(401).send('Wrong password');
      return;
    }

    const { id } = request.params as { id: string };
    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) {
      reply.status(404).send({ error: 'Order not found' });
      return;
    }

    try {
      await markOrderPaid(order.orderNumber, 'manual-admin-confirmation');
      await notifyCustomerOfPayment(order.orderNumber);
      logger.info({ orderId: id, orderNumber: order.orderNumber }, 'Order marked paid manually');
      return { ok: true };
    } catch (err) {
      logger.error({ err, orderId: id }, 'Manual mark-paid failed');
      reply.status(500).send({ error: 'Failed to mark paid' });
    }
  });
}
