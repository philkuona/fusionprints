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
import { setProductCost } from '@/services/cost-overrides.js';
import { getOrderMinimums, setOrderMinimums, type OrderMinimums } from '@/services/store-settings.js';
import { logger } from '@/utils/logger.js';
import { requireFullAdmin, requireFullAdminPage } from '@/utils/auth.js';
import { adminShell } from '@/routes/admin-theme.js';

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageHtml(notice?: string, minimums?: OrderMinimums): string {
  const group = (type: 'photo_print' | 'poster', title: string) => {
    const rows = PRODUCTS.filter((p) => p.productType === type)
      .map((p) => {
        const cost = p.costUsd ?? 0;
        const margin = p.unitPriceUsd > 0 ? Math.round(((p.unitPriceUsd - cost) / p.unitPriceUsd) * 100) : 0;
        const marginClass = cost > 0 ? (margin < 40 ? 'lo' : '') : 'na';
        return `<tr>
          <td>${esc(p.displayLabel)}</td>
          <td class="code">${esc(p.sizeCode)}</td>
          <td><span class="cur">$</span><input type="number" name="price_${esc(p.sizeCode)}" value="${p.unitPriceUsd.toFixed(2)}" step="0.01" min="0" required></td>
          <td><span class="cur">$</span><input type="number" name="cost_${esc(p.sizeCode)}" value="${cost.toFixed(2)}" step="0.01" min="0"></td>
          <td class="margin ${marginClass}">${cost > 0 ? margin + '%' : '—'}</td>
        </tr>`;
      })
      .join('');
    return `<h2>${title}</h2><table><thead><tr><th>Size</th><th>Code</th><th>Price</th><th>Cost</th><th>Margin</th></tr></thead><tbody>${rows}</tbody></table>`;
  };

  const extraCss = `
    main table { max-width:680px; margin-bottom:8px; }
    td.code { color:var(--text2); font-family:'DM Mono',monospace; font-size:13px; }
    .cur { color:var(--text2); margin-right:4px; }
    main input[type=number] { width:96px; }
    td.margin { font-family:'DM Mono',monospace; font-size:13px; color:var(--text2); text-align:right; }
    td.margin.lo { color:#C0392B; font-weight:600; }
    td.margin.na { color:var(--border); }`;

  const body = `
  <div class="page-header">
    <h1>Product pricing</h1>
    <div class="sub">USD per single print. Price updates everywhere live (website, WhatsApp, checkout). Cost is your consumable cost (ribbon/ink + paper) — it drives margin in Key Metrics and is snapshotted onto each order.</div>
  </div>
  ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
  <form method="post" action="/admin/pricing" enctype="multipart/form-data">
    ${group('photo_print', 'Photo prints')}
    ${group('poster', 'Wall art')}

    <h2>Order minimums</h2>
    <div class="sub">Minimum order total (USD) per fulfilment, to meet Payonify&rsquo;s minimum charge.</div>
    <table><tbody>
      <tr><td>Collection / pickup</td><td><span class="cur">$</span><input type="number" name="min_pickup" value="${(minimums?.pickupUsd ?? 2).toFixed(2)}" step="0.01" min="0" required></td></tr>
      <tr><td>Delivery</td><td><span class="cur">$</span><input type="number" name="min_delivery" value="${(minimums?.deliveryUsd ?? 5).toFixed(2)}" step="0.01" min="0" required></td></tr>
    </tbody></table>

    <button class="btn primary" type="submit" style="margin-top:18px;">Save</button>
  </form>`;
  return adminShell({ active: 'pricing', title: 'Pricing', body, role: 'full', extraCss });
}

export async function registerAdminPricing(app: FastifyInstance): Promise<void> {
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 0, fields: 100 } });
  }

  app.get('/admin/pricing', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    const notice = (request.query as { msg?: string })?.msg;
    const minimums = await getOrderMinimums();
    reply.type('text/html').send(pageHtml(notice, minimums));
  });

  app.post('/admin/pricing', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const updates: Array<{ sizeCode: string; price: number }> = [];
      const costUpdates: Array<{ sizeCode: string; cost: number }> = [];
      let minPickup: number | undefined;
      let minDelivery: number | undefined;
      for await (const part of (request as any).parts()) {
        if (part.type === 'file' || typeof part.fieldname !== 'string') continue;
        if (part.fieldname.startsWith('price_')) {
          const sizeCode = part.fieldname.slice('price_'.length);
          const price = Number(part.value);
          if (Number.isFinite(price) && price >= 0) updates.push({ sizeCode, price });
        } else if (part.fieldname.startsWith('cost_')) {
          const sizeCode = part.fieldname.slice('cost_'.length);
          const cost = Number(part.value);
          if (Number.isFinite(cost) && cost >= 0) costUpdates.push({ sizeCode, cost });
        } else if (part.fieldname === 'min_pickup') {
          const v = Number(part.value);
          if (Number.isFinite(v) && v >= 0) minPickup = v;
        } else if (part.fieldname === 'min_delivery') {
          const v = Number(part.value);
          if (Number.isFinite(v) && v >= 0) minDelivery = v;
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
      for (const u of costUpdates) {
        try {
          await setProductCost(u.sizeCode, u.cost);
        } catch (err) {
          logger.warn({ err, ...u }, 'Skipped invalid cost update');
        }
      }
      if (minPickup !== undefined && minDelivery !== undefined) {
        await setOrderMinimums({ pickupUsd: minPickup, deliveryUsd: minDelivery });
      }
      return reply.redirect(`/admin/pricing?msg=Saved+${saved}+prices+%2B+minimums`);
    } catch (err) {
      logger.error({ err }, 'Failed to save prices');
      return reply.redirect('/admin/pricing?msg=Save+failed');
    }
  });
}
