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

export interface PayonifyCharge {
  id: string;
  status: string;
}

/**
 * Create a direct EcoCash mobile-money charge (USSD/PIN push to the customer's
 * phone) — used by the WhatsApp bot. Asynchronous: this returns once the push is
 * accepted; the actual approval is confirmed later via the `charge.succeeded`
 * webhook (which reconciles via metadata.order_number, same as web checkout).
 */
export async function createEcocashCharge(params: {
  orderNumber: string;
  amountUsd: number;
  ecocashNumber: string;
}): Promise<PayonifyCharge> {
  const amountCents = Math.round(params.amountUsd * 100);
  // Payonify's example uses the bare 9-digit MSISDN (e.g. "771234567").
  const mobileNumber = params.ecocashNumber.replace(/\D/g, '').replace(/^263/, '').replace(/^0/, '');

  const body = {
    amount: amountCents,
    currency: 'usd',
    // Required by the charges API; the docs' EcoCash example uses "pos".
    source: 'pos',
    // Create + confirm in one call so the EcoCash USSD push is sent immediately
    // (without this the charge sits at "requires_confirmation").
    confirm: true,
    payment_method: { mobile_money: { ecocash: { mobile_number: mobileNumber } } },
    metadata: { order_number: params.orderNumber },
  };

  const res = await fetch(`${API_BASE}/charges`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error({ status: res.status, error: errText, orderNumber: params.orderNumber }, 'Payonify EcoCash charge failed');
    throw new Error(`Payonify EcoCash charge failed: ${res.status}`);
  }

  const json = (await res.json()) as { id: string; status: string };
  logger.info({ orderNumber: params.orderNumber, chargeId: json.id, status: json.status }, 'Payonify EcoCash charge created');
  return { id: json.id, status: json.status };
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

  // Reject stale signatures (replay protection). Payonify sends the timestamp
  // in NANOSECONDS (19 digits); normalise to seconds before the window check.
  // (The HMAC below signs the literal `t` string, so it's unaffected by units.)
  const tsRaw = Number(parts.t);
  if (!Number.isFinite(tsRaw)) return false;
  let tsSec = tsRaw;
  if (tsSec > 1e17) tsSec = tsSec / 1e9; // nanoseconds → seconds
  else if (tsSec > 1e14) tsSec = tsSec / 1e6; // microseconds → seconds
  else if (tsSec > 1e11) tsSec = tsSec / 1e3; // milliseconds → seconds
  if (Math.abs(Date.now() / 1000 - tsSec) > toleranceSeconds) return false;

  const expected = createHmac('sha256', env.PAYONIFY_WEBHOOK_SECRET)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(parts.v1, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
