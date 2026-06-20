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
    await resend.emails.send({
      from: 'FusionPrints <noreply@fusionprints.co.zw>',
      to: env.OPERATOR_ALERT_EMAIL,
      subject: `🟡 5×7 media swap needed — Order ${orderNumber}`,
      html,
    });
    logger.info({ orderNumber, to: env.OPERATOR_ALERT_EMAIL }, 'Sent 5×7 operator alert email');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to send 5×7 operator alert email');
  }
}
