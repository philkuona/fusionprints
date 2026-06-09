/**
 * Payonify payment gateway (https://docs.payonify.com).
 *
 * Zimbabwe-focused gateway (EcoCash / OneMoney / ZimSwitch / Visa / Mastercard)
 * with a Stripe-style API. We use EMBEDDED checkout: create a checkout session
 * server-side here, hand the `client_secret` to the browser (Drop-In modal), and
 * treat the signed webhook as the source of truth for fulfilment.
 *
 * Auth: HTTP Basic, base64("<publishable>:<secret>"). Amounts are in MINOR units
 * (USD cents). Same base URL for test/live — the key prefix (pk_test_/pk_live_)
 * selects the environment.
 *
 * Secrets come from env only (PAYONIFY_*), never hard-coded or logged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

const API_BASE = 'https://api.payonify.com/v1';

function authHeader(): string {
  const token = Buffer.from(`${env.PAYONIFY_PUBLISHABLE_KEY}:${env.PAYONIFY_SECRET_KEY}`).toString('base64');
  return `Basic ${token}`;
}

export interface PayonifyCheckoutSession {
  id: string;
  clientSecret: string;
  url: string | null;
  status: string;
}

/**
 * Create an embedded checkout session for an order. Returns the client_secret
 * the browser mounts the Drop-In with, plus the session id (our payment ref).
 */
export async function createCheckoutSession(params: {
  orderNumber: string;
  amountUsd: number;
  customerEmail?: string | null;
}): Promise<PayonifyCheckoutSession> {
  const amountCents = Math.round(params.amountUsd * 100);

  const body: Record<string, unknown> = {
    mode: 'payment',
    currency: 'usd',
    line_items: [
      {
        name: `FusionPrints order ${params.orderNumber}`,
        unit_amount: amountCents,
        quantity: 1,
      },
    ],
    // metadata.order_number is how the webhook reconciles back to our order.
    metadata: { order_number: params.orderNumber },
    success_url: `${env.WEB_URL}/account/orders/${params.orderNumber}?placed=1`,
    cancel_url: `${env.WEB_URL}/checkout/payment`,
  };
  if (params.customerEmail) body.customer_email = params.customerEmail;

  const res = await fetch(`${API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error({ status: res.status, error: errText, orderNumber: params.orderNumber }, 'Payonify session create failed');
    throw new Error(`Payonify session create failed: ${res.status}`);
  }

  const json = (await res.json()) as {
    id: string;
    client_secret: string;
    url?: string | null;
    status: string;
  };
  return { id: json.id, clientSecret: json.client_secret, url: json.url ?? null, status: json.status };
}

/**
 * Verify a Payonify webhook signature.
 * Header: `Payonify-Signature: t=<unix>,v1=<hex hmac>`
 * Signed string: `<t>.<raw request body>`, HMAC-SHA256 with the whsec_ secret.
 *
 * `rawBody` MUST be the exact bytes received (not a re-serialised object).
 * Returns false on any malformed/expired/mismatching signature.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader || !env.PAYONIFY_WEBHOOK_SECRET) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  ) as { t?: string; v1?: string };

  if (!parts.t || !parts.v1) return false;

  // Reject stale signatures (replay protection).
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const expected = createHmac('sha256', env.PAYONIFY_WEBHOOK_SECRET)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(parts.v1, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
