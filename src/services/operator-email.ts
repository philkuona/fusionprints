/**
 * Internal operator alerts by email (Resend).
 *
 * Currently the 5×7 "media swap needed" alert: sent to OPERATOR_ALERT_EMAIL when
 * a paid order contains a 5×7, because the single DNP DS620A needs a manual media
 * swap before those prints can run. Best-effort — failures are logged, never
 * thrown, so an alert problem can never roll back or block a paid order.
 */
import { Resend } from 'resend';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

export async function sendFiveBySevenOperatorEmail(
  orderNumber: string,
  readyDateStr: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    logger.warn({ orderNumber }, '5×7 alert: RESEND_API_KEY unset, skipping operator email');
    return;
  }

  const adminUrl = `${env.PUBLIC_URL}/admin`;
  const html = `
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fbf7f0;padding:32px 24px;color:#1f1b16;">
    <h1 style="font-size:20px;margin:0 0 4px;">🟡 5×7 media swap needed</h1>
    <p style="color:#4a3f32;margin:0 0 20px;">A paid order contains a 5×7 print, so the whole order is scheduled for the next working day.</p>

    <div style="background:#ffffff;border:1px solid #e7ded0;border-radius:14px;padding:20px;">
      <p style="margin:0 0 6px;font-family:monospace;color:#8a7b66;">Order ${orderNumber}</p>
      <p style="margin:0;font-size:15px;"><strong>Ready by ${readyDateStr}</strong></p>
    </div>

    <ol style="color:#4a3f32;font-size:14px;line-height:1.6;margin:20px 0 0;padding-left:18px;">
      <li>Load 5×7 media on the DNP DS620A.</li>
      <li>In the admin dashboard, switch DNP media mode to <strong>5×7</strong>. This releases the held 5×7 batch and pauses the regular 4×6 / 6×8 prints.</li>
      <li>When the 5×7 batch is done, switch back to <strong>6×8</strong> so regular prints resume.</li>
    </ol>

    <a href="${adminUrl}" style="display:inline-block;margin-top:20px;background:#05d668;color:#1f1b16;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px;">Open admin dashboard</a>

    <p style="color:#8a7b66;font-size:12px;margin-top:28px;">FusionPrints operations.</p>
  </div>`;

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    // resend.emails.send() does NOT throw on API errors — it returns { error }.
    // Must inspect it, or a rejected send (e.g. bad API key) looks like success.
    const { data, error } = await resend.emails.send({
      from: 'FusionPrints <noreply@fusionprints.co.zw>',
      to: env.OPERATOR_ALERT_EMAIL,
      subject: `🟡 5×7 media swap needed — Order ${orderNumber}`,
      html,
    });
    if (error) {
      logger.error({ orderNumber, to: env.OPERATOR_ALERT_EMAIL, error }, 'Resend rejected 5×7 operator alert email');
      return;
    }
    logger.info({ orderNumber, to: env.OPERATOR_ALERT_EMAIL, id: data?.id }, 'Sent 5×7 operator alert email');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to send 5×7 operator alert email');
  }
}

/**
 * Alert ops that a customer has requested to cancel a paid order, so it gets
 * reviewed (approve → refund, or decline) instead of sitting unnoticed.
 * Best-effort. (PR-12)
 */
export async function sendCancellationRequestAlert(
  orderNumber: string,
  amountUsd: string,
  reason: string | null,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    logger.warn({ orderNumber }, 'Cancellation alert: RESEND_API_KEY unset, skipping operator email');
    return;
  }

  const adminUrl = `${env.PUBLIC_URL}/admin?order=${orderNumber}`;
  const html = `
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fbf7f0;padding:32px 24px;color:#1f1b16;">
    <h1 style="font-size:20px;margin:0 0 4px;">🟠 Cancellation requested</h1>
    <p style="color:#4a3f32;margin:0 0 20px;">A customer asked to cancel a paid order. Review it in the dashboard — approve to refund via Payonify, or decline.</p>
    <div style="background:#ffffff;border:1px solid #e7ded0;border-radius:14px;padding:20px;">
      <p style="margin:0 0 6px;font-family:monospace;color:#8a7b66;">Order ${orderNumber}</p>
      <p style="margin:0 0 8px;font-size:15px;"><strong>$${Number(amountUsd).toFixed(2)}</strong> paid</p>
      ${reason ? `<p style="margin:0;color:#4a3f32;font-size:14px;">Reason: &ldquo;${reason.replace(/[<>]/g, '')}&rdquo;</p>` : ''}
    </div>
    <a href="${adminUrl}" style="display:inline-block;margin-top:20px;background:#05d668;color:#1f1b16;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px;">Review the request</a>
    <p style="color:#8a7b66;font-size:12px;margin-top:28px;">FusionPrints operations.</p>
  </div>`;

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: 'FusionPrints <noreply@fusionprints.co.zw>',
      to: env.OPERATOR_ALERT_EMAIL,
      subject: `🟠 Cancellation requested — Order ${orderNumber}`,
      html,
    });
    if (error) {
      logger.error({ orderNumber, to: env.OPERATOR_ALERT_EMAIL, error }, 'Resend rejected cancellation alert email');
      return;
    }
    logger.info({ orderNumber, to: env.OPERATOR_ALERT_EMAIL }, 'Sent cancellation request alert email');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to send cancellation alert email');
  }
}
