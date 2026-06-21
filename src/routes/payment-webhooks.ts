/**
 * Payment-related routes.
 *
 * Live payment confirmation runs through Payonify's signed webhook
 * (routes/web/payonify-webhook.ts), which marks orders paid for both web and
 * bot channels. This file holds the shared customer-notification helper and the
 * admin manual mark-paid fallback (for when an automatic confirmation is missed).
 */

import type { FastifyInstance } from 'fastify';
import { markOrderPaid, getOrderByNumber } from '@/services/order.js';
import { logger } from '@/utils/logger.js';
import { sendWhatsAppMessage } from '@/services/whatsapp.js';
import { sendWhatsAppReceipt } from '@/services/receipt-pdf.js';
import { db } from '@/db/client.js';
import { customers, orders, orderItems } from '@/db/schema.js';
import { eq } from 'drizzle-orm';
import { MSG } from '@/bot/messages.js';
import { requireFullAdmin } from '@/utils/auth.js';

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

  // Follow the in-chat confirmation with the branded PDF receipt (best-effort).
  await sendWhatsAppReceipt(orderNumber).catch((err) =>
    logger.error({ err, orderNumber }, 'Failed to send WhatsApp receipt'),
  );
}

/**
 * WhatsApp notification when a payment attempt fails/times out (async, via the
 * Payonify webhook). Without this the customer is stranded on "Waiting for
 * confirmation…" after a failed/slow EcoCash auth. The bot is parked in
 * awaiting_ecocash_pin, which already handles 1 (retry) / 2 (cancel), so the
 * prompt's options match — no conversation-state surgery needed. The order stays
 * pending_payment (retryable); if untouched it's auto-cancelled + its QBO invoice
 * voided by the 24h abandoned-checkout sweep. No-ops for web orders. Best-effort.
 */
export async function notifyCustomerOfPaymentFailure(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order || !order.customerId) return; // WhatsApp orders only

  const [customer] = await db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1);
  if (!customer) return;

  const to = customer.phoneNumber.replace(/^\+/, '');
  try {
    await sendWhatsAppMessage(to, MSG.paymentFailed(orderNumber));
    logger.info({ orderNumber }, 'Notified WhatsApp customer of payment failure');
  } catch (err) {
    logger.error({ err, orderNumber }, 'Failed to send payment-failure notification');
  }
}

/**
 * WhatsApp notification for a cancellation outcome (PR-12). 'refunded' when an
 * admin approves + the refund succeeds; 'declined' when they decline. No-ops for
 * web orders (no WhatsApp customer) and is best-effort.
 */
export async function notifyCustomerOfCancellation(
  orderNumber: string,
  outcome: 'refunded' | 'declined',
): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order || !order.customerId) return;

  const [customer] = await db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1);
  if (!customer) return;

  const message = outcome === 'refunded' ? MSG.refundIssued(orderNumber) : MSG.cancellationDeclined(orderNumber);
  const to = customer.phoneNumber.replace(/^\+/, '');
  try {
    await sendWhatsAppMessage(to, message);
  } catch (err) {
    logger.error({ err, orderNumber, outcome }, 'Failed to send cancellation notification');
  }
}

export async function registerPaymentWebhooks(app: FastifyInstance): Promise<void> {

  // ===== Manual confirmation endpoint (admin only) =====
  // Used when payment confirmation didn't come through automatically — e.g.
  // customer paid but webhook failed. Admin can manually mark the order paid.
  app.post('/admin/api/ops/orders/:id/mark-paid', async (request, reply) => {
    // Session-based admin auth, consistent with the rest of /admin/api/* (was
    // inline Basic auth with a non-constant-time compare and no rate limit).
    if (!requireFullAdmin(request, reply)) return;

    const { id } = request.params as { id: string };
    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) {
      return reply.status(404).send({ error: 'Order not found' });
    }

    try {
      await markOrderPaid(order.orderNumber, 'manual-admin-confirmation');
      await notifyCustomerOfPayment(order.orderNumber);
      logger.info({ orderId: id, orderNumber: order.orderNumber }, 'Order marked paid manually');
      return { ok: true };
    } catch (err) {
      logger.error({ err, orderId: id }, 'Manual mark-paid failed');
      return reply.status(500).send({ error: 'Failed to mark paid' });
    }
  });
}
