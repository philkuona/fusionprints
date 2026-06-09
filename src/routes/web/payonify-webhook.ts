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
import { payments } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { verifyWebhookSignature } from '@/services/payonify.js';
import { markOrderPaid, getOrderByNumber } from '@/services/order.js';
import { sendWebOrderConfirmation } from '@/services/web-order-email.js';

interface PayonifyEvent {
  type?: string;
  data?: { object?: { id?: string; metadata?: Record<string, string> } };
}

async function fulfilPaidOrder(orderNumber: string, reference: string, rawPayload: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) {
    logger.warn({ orderNumber }, 'Payonify webhook: no matching order');
    return;
  }

  // Record success + keep the raw payload for debugging.
  let payload: unknown = null;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    /* keep null */
  }
  await db
    .update(payments)
    .set({ status: 'success', completedAt: new Date(), webhookPayload: payload })
    .where(eq(payments.orderId, order.id));

  // Only advance fulfilment once (guard against duplicate webhook deliveries).
  if (order.status === 'pending_payment') {
    await markOrderPaid(orderNumber, reference);
    await sendWebOrderConfirmation(orderNumber).catch(() => {});
    logger.info({ orderNumber, reference }, 'Payonify webhook: order marked paid');
  }
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

      // Diagnostic: confirm reachability + signature result regardless of outcome.
      const sigValid = verifyWebhookSignature(raw, sig);
      let peekType = '';
      try {
        peekType = (JSON.parse(raw) as PayonifyEvent).type ?? '';
      } catch {
        /* not json */
      }
      logger.info({ hasSig: !!sig, sigValid, type: peekType, bytes: raw.length }, 'Payonify webhook hit');

      if (!sigValid) {
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

      if (type.endsWith('.succeeded') && orderNumber) {
        try {
          await fulfilPaidOrder(orderNumber, event.data?.object?.id ?? orderNumber, raw);
        } catch (err) {
          // 500 → Payonify retries. Idempotency guard makes retries safe.
          logger.error({ orderNumber, err }, 'Payonify webhook: fulfilment failed');
          return reply.status(500).send({ error: 'processing_failed' });
        }
      }

      // Acknowledge everything we don't act on (other event types, failures).
      return reply.status(200).send({ received: true });
    });
  });
}
