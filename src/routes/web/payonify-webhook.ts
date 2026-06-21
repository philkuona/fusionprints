/**
 * Payonify webhook — the source of truth for web-order payment.
 *
 *   POST /web/api/payments/payonify/webhook
 *
 * Payonify calls this on payment lifecycle events. We verify the
 * `Payonify-Signature` (HMAC-SHA256 over `<t>.<raw body>` with the whsec_
 * secret) against the RAW request bytes, then — on a `*.succeeded` event
 * carrying our `metadata.order_number` — mark the payment + order paid and
 * trigger fulfilment. Idempotent: re-deliveries are no-ops once paid.
 *
 * Raw-body capture is scoped to this encapsulated plugin so the rest of the
 * app keeps Fastify's default JSON parser.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { payments, orders } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { verifyWebhookSignature } from '@/services/payonify.js';
import { markOrderPaid, getOrderByNumber } from '@/services/order.js';
import { sendOrderReceipt } from '@/services/web-order-email.js';
import { notifyCustomerOfPayment, notifyCustomerOfPaymentFailure } from '@/routes/payment-webhooks.js';

/** The refundable charge id (ch_…): a checkout session exposes it as
 * `transaction_reference`; a direct charge object IS the ch_ (in `id`). Refunds
 * MUST target this, not the cs_ session in `id`/providerReference. */
function chargeIdFromObject(obj?: { id?: string; transaction_reference?: string }): string | null {
  return obj?.transaction_reference ?? obj?.id ?? null;
}

interface PayonifyEvent {
  type?: string;
  data?: { object?: { id?: string; transaction_reference?: string; metadata?: Record<string, string>; payment_method?: string } };
}

/**
 * Map Payonify's payment_method to our internal value, which drives the QBO
 * deposit account (services/qbo.ts depositAccountId): 'card' → Payonify account,
 * 'ecocash' → EcoCash Business account, anything else → Cash on Hand.
 * Decision (2026-06-19): keep EcoCash on its own account; only card → Payonify.
 */
function mapPayonifyMethod(method: string | undefined): string | null {
  if (method === 'card') return 'card';
  if (method === 'mobile_money') return 'ecocash'; // EcoCash / OneMoney USSD
  return null;
}

async function fulfilPaidOrder(
  orderNumber: string,
  reference: string,
  rawPayload: string,
  paymentMethod: string | null,
  chargeReference: string | null,
): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) {
    logger.warn({ orderNumber }, 'Payonify webhook: no matching order');
    return;
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    /* keep null */
  }

  // Atomically record the payment success AND flip the order to paid, under a
  // row lock. This closes two races: (a) two webhook deliveries arriving at once
  // both seeing pending_payment, and (b) a crash between the payment write and
  // the order write leaving them inconsistent. Only the holder that flips the
  // order runs fulfilment, so retries can't double-fulfil or double-notify.
  let shouldFulfil = false;
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, order.id))
      .for('update');
    await tx
      .update(payments)
      .set({
        status: 'success',
        completedAt: new Date(),
        webhookPayload: payload,
        // The refundable charge id (ch_…) — NOT the cs_ session in `reference`.
        // For web checkout this is the session's transaction_reference; refunds
        // against the session id fail ("charge does not exist"). (PR-12)
        ...(chargeReference ? { chargeReference } : {}),
        // Record the real method so QBO deposits to the right account. Only set
        // when known — don't overwrite an existing value with null.
        ...(paymentMethod ? { paymentMethod } : {}),
      })
      .where(eq(payments.orderId, order.id));
    if (locked?.status === 'pending_payment') {
      await tx.update(orders).set({ status: 'paid', paidAt: new Date() }).where(eq(orders.id, order.id));
      shouldFulfil = true;
    }
  });

  if (!shouldFulfil) return; // already paid by a prior delivery — nothing more to do

  // Post-commit side effects (idempotent: enqueue checks for existing jobs).
  // markOrderPaid re-sets status (harmless) and enqueues print jobs + slips.
  await markOrderPaid(orderNumber, reference);
  // Branded receipt email — both channels (self-guards on email presence).
  await sendOrderReceipt(orderNumber).catch((err: unknown) => {
    logger.error({ err, orderNumber }, 'Order receipt email failed');
  });
  // In-chat plain-text confirmation for WhatsApp customers.
  if (order.channel !== 'web') {
    await notifyCustomerOfPayment(orderNumber).catch((err: unknown) => {
      logger.error({ err, orderNumber }, 'WhatsApp payment notification failed');
    });
  }
  logger.info({ orderNumber, reference, channel: order.channel }, 'Payonify webhook: order marked paid');
}

/** Mark the payment attempt failed (order stays pending so it can be retried).
 * Returns true only when it actually transitioned a pending order to failed —
 * so the caller notifies the customer once, not on every webhook re-delivery. */
async function markPaymentFailed(orderNumber: string, rawPayload: string): Promise<boolean> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) {
    logger.warn({ orderNumber }, 'Payonify webhook (failed): no matching order');
    return false;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    /* keep null */
  }
  // Don't clobber an already-successful payment (out-of-order delivery).
  if (order.status === 'pending_payment') {
    await db
      .update(payments)
      .set({ status: 'failed', completedAt: new Date(), webhookPayload: payload })
      .where(eq(payments.orderId, order.id));
    logger.info({ orderNumber }, 'Payonify webhook: payment marked failed');
    return true;
  }
  return false;
}

export async function registerPayonifyWebhook(app: FastifyInstance): Promise<void> {
  await app.register(async (webhookApp) => {
    // Keep the raw body (string) so the HMAC signature can be verified against
    // the exact bytes Payonify signed. Scoped to this plugin only.
    webhookApp.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    webhookApp.post('/web/api/payments/payonify/webhook', async (request, reply) => {
      const raw = typeof request.body === 'string' ? request.body : '';
      const sig = request.headers['payonify-signature'] as string | undefined;

      if (!verifyWebhookSignature(raw, sig)) {
        logger.warn('Payonify webhook: invalid or missing signature');
        return reply.status(400).send({ error: 'invalid_signature' });
      }

      let event: PayonifyEvent;
      try {
        event = JSON.parse(raw) as PayonifyEvent;
      } catch {
        return reply.status(400).send({ error: 'invalid_json' });
      }

      const type = event.type ?? '';
      const orderNumber = event.data?.object?.metadata?.order_number;
      logger.info({ type, orderNumber: orderNumber ?? null }, 'Payonify webhook event');

      // Scope to PAYMENT lifecycle events only. `endsWith('.succeeded')` also
      // matched `refund.succeeded` — and our refundPayment() sets the order
      // number in metadata, so a refund would re-run fulfilment + flip the
      // payment back to success. Same trap on `.failed` (refund.failed).
      const isPaymentSucceeded = type === 'checkout.succeeded' || type === 'charge.succeeded';
      const isPaymentFailed = type === 'checkout.failed' || type === 'charge.failed';

      if (isPaymentSucceeded && orderNumber) {
        try {
          await fulfilPaidOrder(
            orderNumber,
            event.data?.object?.id ?? orderNumber,
            raw,
            mapPayonifyMethod(event.data?.object?.payment_method),
            chargeIdFromObject(event.data?.object),
          );
        } catch (err) {
          // 500 → Payonify retries. Idempotency guard makes retries safe.
          logger.error({ orderNumber, err }, 'Payonify webhook: fulfilment failed');
          return reply.status(500).send({ error: 'processing_failed' });
        }
      } else if (isPaymentFailed && orderNumber) {
        try {
          // Only notify when this delivery actually flipped a pending order to
          // failed — so webhook re-deliveries don't re-message the customer.
          const transitioned = await markPaymentFailed(orderNumber, raw);
          if (transitioned) {
            await notifyCustomerOfPaymentFailure(orderNumber).catch((err: unknown) =>
              logger.error({ orderNumber, err }, 'Payonify webhook: failure notification errored'),
            );
          }
        } catch (err) {
          logger.error({ orderNumber, err }, 'Payonify webhook: marking failed errored');
        }
      }

      // Acknowledge everything we don't act on (other event types).
      return reply.status(200).send({ received: true });
    });
  });
}
