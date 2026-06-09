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
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { payments } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { env } from '@/config/env.js';
import { verifyWebhookSignature } from '@/services/payonify.js';

/**
 * TEMP diagnostic: try the likely signing variants and log which (if any)
 * matches the received v1. Lets us pin Payonify's exact scheme in one retest.
 * Logs only hashes (not the secret). Remove once the scheme is confirmed.
 */
function debugSignature(rawBody: string, header: string | undefined): void {
  if (!header) return;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  ) as { t?: string; v1?: string };
  const t = parts.t ?? '';
  const v1 = parts.v1 ?? '';
  const secret = env.PAYONIFY_WEBHOOK_SECRET;
  const noPrefix = secret.replace(/^whsec_/, '');
  const hmac = (key: string | Buffer, msg: string, enc: 'hex' | 'base64') =>
    createHmac('sha256', key).update(msg).digest(enc);
  const candidates: Record<string, string> = {
    'secret|t.body|hex': hmac(secret, `${t}.${rawBody}`, 'hex'),
    'secret|body|hex': hmac(secret, rawBody, 'hex'),
    'noprefix|t.body|hex': hmac(noPrefix, `${t}.${rawBody}`, 'hex'),
    'secret|t.body|b64': hmac(secret, `${t}.${rawBody}`, 'base64'),
    'b64key|t.body|hex': hmac(Buffer.from(noPrefix, 'base64'), `${t}.${rawBody}`, 'hex'),
  };
  const match = Object.entries(candidates).find(([, sig]) => sig === v1)?.[0] ?? 'NONE';
  const nowSec = Math.floor(Date.now() / 1000);
  logger.warn(
    {
      tsDeltaSec: t ? nowSec - Number(t) : null,
      v1Recv: v1.slice(0, 16),
      match,
      cand_secret_t_body_hex: candidates['secret|t.body|hex'].slice(0, 16),
    },
    'Payonify signature debug',
  );
}
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
        debugSignature(raw, sig); // TEMP — identify the correct signing scheme
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
