/**
 * Branded order receipt email — both channels.
 *
 * Sent once when an order's payment is confirmed, to whoever has an email on
 * file: a web user (always) or a WhatsApp customer who gave one (optional). The
 * in-chat plain-text confirmation is sent separately for WhatsApp. Idempotent via
 * orders.receiptSentAt. Best-effort: failures are logged, never thrown.
 */
import { Resend } from 'resend';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, webUsers, customers } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { getProduct } from '@/config/catalog.js';
import { getOrderCollectionPoint } from '@/services/collection-points.js';

function money(v: string | number): string {
  return `$${Number(v).toFixed(2)}`;
}

type OrderRow = typeof orders.$inferSelect;

/** Resolve the email + first name for whichever channel an order came through. */
async function resolveOrderRecipient(order: OrderRow): Promise<{ email: string | null; firstName: string; isWeb: boolean }> {
  if (order.channel === 'web' && order.webUserId) {
    const [u] = await db
      .select({ email: webUsers.email, displayName: webUsers.displayName })
      .from(webUsers)
      .where(eq(webUsers.id, order.webUserId))
      .limit(1);
    return { email: u?.email ?? null, firstName: u?.displayName?.split(/\s+/)[0] ?? 'there', isWeb: true };
  }
  if (order.customerId) {
    const [c] = await db
      .select({ email: customers.email, name: customers.name })
      .from(customers)
      .where(eq(customers.id, order.customerId))
      .limit(1);
    return { email: c?.email ?? null, firstName: c?.name?.split(/\s+/)[0] ?? 'there', isWeb: false };
  }
  return { email: null, firstName: 'there', isWeb: false };
}

/** Wrap body HTML in the brand email shell (cream card, ink text). */
function brandEmail(heading: string, bodyHtml: string): string {
  return `
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fbf7f0;padding:32px 24px;color:#1f1b16;">
    <h1 style="font-size:22px;margin:0 0 12px;">${heading}</h1>
    ${bodyHtml}
    <p style="color:#8a7b66;font-size:12px;margin-top:28px;">FusionPrints. Hold the moment.</p>
  </div>`;
}

/** Send one transactional email; returns true on success. Best-effort, never throws. */
async function sendBrandEmail(to: string, subject: string, html: string, orderNumber: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    logger.warn({ orderNumber }, 'No RESEND_API_KEY; skipping email');
    return false;
  }
  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from: 'FusionPrints <noreply@fusionprints.co.zw>', to, subject, html });
    if (error) {
      logger.error({ orderNumber, to, error }, 'Resend rejected email');
      return false;
    }
    logger.info({ orderNumber, to }, 'Sent transactional email');
    return true;
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to send email');
    return false;
  }
}

/**
 * Send the branded receipt for a paid order (web or WhatsApp). No-ops if there's
 * no recipient email, no Resend key, or it was already sent.
 */
export async function sendOrderReceipt(orderNumber: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order) return;
  if (order.receiptSentAt) return; // already sent

  // Resolve the recipient email + first name from whichever channel the order
  // came through. WhatsApp customers may have no email (it's optional) — then
  // there's nothing to send here (they got the in-chat confirmation instead).
  let email: string | null = null;
  let firstName = 'there';
  let isWeb = false;
  if (order.channel === 'web' && order.webUserId) {
    const [u] = await db
      .select({ email: webUsers.email, displayName: webUsers.displayName })
      .from(webUsers)
      .where(eq(webUsers.id, order.webUserId))
      .limit(1);
    email = u?.email ?? null;
    firstName = u?.displayName?.split(/\s+/)[0] ?? 'there';
    isWeb = true;
  } else if (order.customerId) {
    const [c] = await db
      .select({ email: customers.email, name: customers.name })
      .from(customers)
      .where(eq(customers.id, order.customerId))
      .limit(1);
    email = c?.email ?? null;
    firstName = c?.name?.split(/\s+/)[0] ?? 'there';
  }
  if (!email) return;

  if (!env.RESEND_API_KEY) {
    logger.warn({ orderNumber }, 'No RESEND_API_KEY; skipping order receipt email');
    return;
  }

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const itemRows = items
    .map((it) => {
      const label = getProduct(it.sizeCode)?.labelInches ?? it.sizeCode;
      const finish = it.paper ? ` (${it.paper})` : '';
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #e7ded0;color:#1f1b16;">${it.quantity} &times; ${label}${finish}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e7ded0;text-align:right;color:#1f1b16;">${money(it.lineTotalUsd)}</td>
      </tr>`;
    })
    .join('');

  const isDelivery = order.fulfillmentMethod === 'delivery';
  let fulfilmentLine: string;
  if (isDelivery) {
    fulfilmentLine = "<strong>Delivery.</strong> We'll be in touch with delivery details.";
  } else {
    const point = await getOrderCollectionPoint(order.collectionPointId);
    const where = point ? `${point.name}, ${point.addressLine}` : env.BUSINESS_NAME;
    fulfilmentLine = `<strong>Collection.</strong> We'll let you know the moment it's ready to collect at <strong>${where}</strong>.`;
  }

  const cta = isWeb
    ? `<a href="${env.WEB_URL}/account/orders/${orderNumber}" style="display:inline-block;margin-top:16px;background:#05d668;color:#1f1b16;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px;">Track your order</a>`
    : '';

  const html = `
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fbf7f0;padding:32px 24px;color:#1f1b16;">
    <h1 style="font-size:22px;margin:0 0 4px;">Thanks, ${firstName}. Your order is confirmed.</h1>
    <p style="color:#4a3f32;margin:0 0 24px;">Payment received. We print everything ourselves, so your order is already on its way to the printer.</p>

    <div style="background:#ffffff;border:1px solid #e7ded0;border-radius:14px;padding:20px;">
      <p style="margin:0 0 12px;font-family:monospace;color:#8a7b66;">Order ${orderNumber}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">${itemRows}</table>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px;">
        <tr><td style="padding:2px 0;color:#4a3f32;">Subtotal</td><td style="padding:2px 0;text-align:right;">${money(order.subtotalUsd)}</td></tr>
        <tr><td style="padding:2px 0;color:#4a3f32;">Delivery</td><td style="padding:2px 0;text-align:right;">${Number(order.deliveryFeeUsd) > 0 ? money(order.deliveryFeeUsd) : 'Free'}</td></tr>
        <tr><td style="padding:6px 0 0;font-weight:bold;">Total</td><td style="padding:6px 0 0;text-align:right;font-weight:bold;">${money(order.totalUsd)}</td></tr>
      </table>
    </div>

    <p style="color:#4a3f32;margin:20px 0 4px;">${fulfilmentLine} Most orders are ready within 24 hours.</p>
    ${cta}
    <p style="color:#8a7b66;font-size:12px;margin-top:28px;">FusionPrints. Hold the moment.</p>
  </div>`;

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    // resend.emails.send() returns { error } instead of throwing on API errors.
    // Only mark the receipt sent when it actually succeeded.
    const { data, error } = await resend.emails.send({
      from: 'FusionPrints <noreply@fusionprints.co.zw>',
      to: email,
      subject: `Order ${orderNumber} confirmed`,
      html,
    });
    if (error) {
      logger.error({ orderNumber, to: email, error }, 'Resend rejected order receipt email');
      return;
    }
    await db.update(orders).set({ receiptSentAt: new Date() }).where(eq(orders.id, order.id));
    logger.info({ orderNumber, to: email, channel: order.channel, id: data?.id }, 'Sent order receipt email');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to send order receipt email');
  }
}

/**
 * Refund-issued email — sent when an admin approves a cancellation and the
 * Payonify refund succeeds. Best-effort; no-ops if there's no recipient email.
 */
export async function sendRefundIssuedEmail(orderNumber: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order) return;
  const { email, firstName } = await resolveOrderRecipient(order);
  if (!email) return;

  const body = `
    <p style="color:#4a3f32;margin:0 0 24px;">Your cancellation is confirmed and we've refunded your payment. It can take a few business days to land back on your account, depending on your bank or mobile money provider.</p>
    <div style="background:#ffffff;border:1px solid #e7ded0;border-radius:14px;padding:20px;">
      <p style="margin:0 0 8px;font-family:monospace;color:#8a7b66;">Order ${orderNumber}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;font-weight:bold;">Refunded</td><td style="padding:6px 0;text-align:right;font-weight:bold;">${money(order.totalUsd)}</td></tr>
      </table>
    </div>
    <p style="color:#4a3f32;margin:20px 0 4px;">Thanks for giving us a try. We'd love to print for you another time.</p>`;
  await sendBrandEmail(email, `Order ${orderNumber} cancelled and refunded`, brandEmail(`You're refunded, ${firstName}.`, body), orderNumber);
}

/**
 * Cancellation-declined email — sent when an admin declines a cancellation
 * request (e.g. the order is already printing). Best-effort.
 */
export async function sendCancellationDeclinedEmail(orderNumber: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order) return;
  const { email, firstName } = await resolveOrderRecipient(order);
  if (!email) return;

  const body = `
    <p style="color:#4a3f32;margin:0 0 16px;">We've looked at your cancellation request for order <strong>${orderNumber}</strong>, but it's already too far along for us to stop and refund it.</p>
    <p style="color:#4a3f32;margin:0 0 4px;">If you think this is a mistake, just reply to this email or message us and we'll sort it out together.</p>`;
  await sendBrandEmail(email, `About your cancellation request — ${orderNumber}`, brandEmail(`Hi ${firstName}, about that cancellation`, body), orderNumber);
}
