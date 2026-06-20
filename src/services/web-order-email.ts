/**
 * Web order confirmation email (Phase 2.3 W6).
 *
 * Sent once, when a web order's payment is confirmed. Idempotent via
 * orders.receiptSentAt. Best-effort: failures are logged, never thrown, so they
 * can't roll back a paid order.
 */
import { Resend } from 'resend';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, webUsers } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { getProduct } from '@/config/catalog.js';

function money(v: string | number): string {
  return `$${Number(v).toFixed(2)}`;
}

export async function sendWebOrderConfirmation(orderNumber: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order || order.channel !== 'web' || !order.webUserId) return;
  if (order.receiptSentAt) return; // already sent

  const [user] = await db
    .select({ email: webUsers.email, displayName: webUsers.displayName })
    .from(webUsers)
    .where(eq(webUsers.id, order.webUserId))
    .limit(1);
  if (!user?.email) return;

  if (!env.RESEND_API_KEY) {
    logger.warn({ orderNumber }, 'No RESEND_API_KEY; skipping order confirmation email');
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

  const fulfilment = order.fulfillmentMethod === 'delivery' ? 'Delivery' : 'Collection';
  const trackUrl = `${env.WEB_URL}/account/orders/${orderNumber}`;
  const name = user.displayName?.split(/\s+/)[0] ?? 'there';

  const html = `
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fbf7f0;padding:32px 24px;color:#1f1b16;">
    <h1 style="font-size:22px;margin:0 0 4px;">Thanks, ${name}. Your order is confirmed.</h1>
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

    <p style="color:#4a3f32;margin:20px 0 4px;"><strong>${fulfilment}.</strong> ${
      order.fulfillmentMethod === 'delivery'
        ? "We'll be in touch with delivery details."
        : "We'll let you know the moment it's ready for pickup."
    } Most orders are ready within 24 hours.</p>

    <a href="${trackUrl}" style="display:inline-block;margin-top:16px;background:#05d668;color:#1f1b16;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px;">Track your order</a>

    <p style="color:#8a7b66;font-size:12px;margin-top:28px;">FusionPrints. Hold the moment.</p>
  </div>`;

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    // resend.emails.send() returns { error } instead of throwing on API errors.
    // Only mark the receipt as sent when it actually succeeded, so a rejected
    // send (e.g. bad API key) doesn't permanently suppress the confirmation.
    const { data, error } = await resend.emails.send({
      from: 'FusionPrints <noreply@fusionprints.co.zw>',
      to: user.email,
      subject: `Order ${orderNumber} confirmed`,
      html,
    });
    if (error) {
      logger.error({ orderNumber, to: user.email, error }, 'Resend rejected web order confirmation email');
      return;
    }
    await db.update(orders).set({ receiptSentAt: new Date() }).where(eq(orders.id, order.id));
    logger.info({ orderNumber, to: user.email, id: data?.id }, 'Sent web order confirmation email');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to send web order confirmation email');
  }
}
