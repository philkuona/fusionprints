/**
 * Admin — Product pricing (USD).
 *
 * Edit the per-size price. Saving persists to product_prices and updates the
 * live price immediately (display, WhatsApp bot, and order totals all follow,
 * since they read the same in-memory catalog). Full-admin only.
 *
 *   GET  /admin/pricing   — table of every size with its current USD price
 *   POST /admin/pricing   — save edited prices
 */

import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { PRODUCTS } from '@/config/catalog.js';
import { setProductPrice } from '@/services/price-overrides.js';
import { logger } from '@/utils/logger.js';
import { requireFullAdmin, requireFullAdminPage } from '@/utils/auth.js';

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageHtml(notice?: string): string {
  const group = (type: 'photo_print' | 'poster', title: string) => {
    const rows = PRODUCTS.filter((p) => p.productType === type)
      .map(
        (p) => `<tr>
          <td>${esc(p.displayLabel)}</td>
          <td class="code">${esc(p.sizeCode)}</td>
          <td><span class="cur">$</span><input type="number" name="price_${esc(p.sizeCode)}" value="${p.unitPriceUsd.toFixed(2)}" step="0.01" min="0" required></td>
        </tr>`,
      )
      .join('');
    return `<h2>${title}</h2><table><thead><tr><th>Size</th><th>Code</th><th>Price (USD)</th></tr></thead><tbody>${rows}</tbody></table>`;
  };

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pricing — FusionPrints admin</title>
<style>
  :root { --bg:#16130f; --surface:#211d17; --surface2:#2b261e; --text:#f3ede2; --mute:#9b8f7c; --accent:#05D668; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui,sans-serif; padding:24px; }
  a { color:var(--accent); }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:15px; color:var(--mute); margin:22px 0 8px; text-transform:uppercase; letter-spacing:.05em; }
  .sub { color:var(--mute); font-size:13px; margin-bottom:8px; }
  .notice { background:var(--accent); color:#13110d; padding:10px 14px; border-radius:8px; margin-bottom:16px; font-weight:600; }
  table { width:100%; max-width:520px; border-collapse:collapse; background:var(--surface); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:10px 14px; border-bottom:1px solid #ffffff10; font-size:14px; }
  th { color:var(--mute); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  td.code { color:var(--mute); font-family:ui-monospace,monospace; font-size:13px; }
  .cur { color:var(--mute); margin-right:4px; }
  input[type=number] { width:110px; padding:7px 10px; background:var(--surface2); border:1px solid #ffffff22; border-radius:8px; color:var(--text); font-size:14px; }
  input:focus { outline:none; border-color:var(--accent); }
  .btn { cursor:pointer; background:var(--accent); color:#13110d; border:none; border-radius:8px; padding:10px 18px; font-size:14px; font-weight:700; margin-top:18px; }
</style></head>
<body>
  <p style="margin:0 0 10px"><a href="/admin">&larr; Admin</a></p>
  <h1>Product pricing</h1>
  <div class="sub">USD per single print. Saving updates the live price everywhere immediately (website, WhatsApp, checkout totals).</div>
  ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
  <form method="post" action="/admin/pricing" enctype="multipart/form-data">
    ${group('photo_print', 'Photo prints')}
    ${group('poster', 'Wall art')}
    <button class="btn" type="submit">Save prices</button>
  </form>
</body></html>`;
}

export async function registerAdminPricing(app: FastifyInstance): Promise<void> {
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 0, fields: 100 } });
  }

  app.get('/admin/pricing', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    const notice = (request.query as { msg?: string })?.msg;
    reply.type('text/html').send(pageHtml(notice));
  });

  app.post('/admin/pricing', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const updates: Array<{ sizeCode: string; price: number }> = [];
      for await (const part of (request as any).parts()) {
        if (part.type !== 'file' && typeof part.fieldname === 'string' && part.fieldname.startsWith('price_')) {
          const sizeCode = part.fieldname.slice('price_'.length);
          const price = Number(part.value);
          if (Number.isFinite(price) && price >= 0) updates.push({ sizeCode, price });
        }
      }
      let saved = 0;
      for (const u of updates) {
        try {
          await setProductPrice(u.sizeCode, u.price);
          saved++;
        } catch (err) {
          logger.warn({ err, ...u }, 'Skipped invalid price update');
        }
      }
      return reply.redirect(`/admin/pricing?msg=Saved+${saved}+prices`);
    } catch (err) {
      logger.error({ err }, 'Failed to save prices');
      return reply.redirect('/admin/pricing?msg=Save+failed');
    }
  });
}
