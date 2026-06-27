/**
 * Admin — Outsource partners directory.
 *
 * Add/edit/deactivate the print shops that produce outsourced sizes (8×10 + wall
 * art), and pick the default partner auto-dispatch (Phase 4) sends to. Entirely
 * customer-invisible. Full-admin only.
 *
 *   GET  /admin/partners               — list + add/edit forms
 *   POST /admin/partners/add           — create a partner
 *   POST /admin/partners/:id/update    — edit a partner
 *   POST /admin/partners/:id/default   — make a partner the sole default
 *   POST /admin/partners/:id/deactivate — deactivate (never deleted)
 */
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { logger } from '@/utils/logger.js';
import { requireFullAdmin, requireFullAdminPage } from '@/utils/auth.js';
import { adminShell } from '@/routes/admin-theme.js';
import {
  listPartners,
  createPartner,
  updatePartner,
  setDefaultPartner,
  deactivatePartner,
  normalizePartnerInput,
  outsourcedSizeCodes,
} from '@/services/outsource-partners.js';
import { getProduct } from '@/config/catalog.js';
import type { OutsourcePartner } from '@/db/schema.js';

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Per-size supported checkbox + wholesale price input, for each outsourced size. */
function sizeRows(p?: OutsourcePartner): string {
  return outsourcedSizeCodes()
    .map((code) => {
      const label = getProduct(code)?.displayLabel ?? code;
      const supported = !p || p.supportedSizes.includes(code);
      const price = p?.wholesalePrices?.[code];
      return `<div class="size-row">
        <label class="chk"><input type="checkbox" name="size_${code}" ${supported ? 'checked' : ''}> ${esc(label)}</label>
        <span class="cost">$ <input class="num" name="price_${code}" type="number" step="0.01" min="0" placeholder="wholesale" value="${price != null ? esc(price.toFixed(2)) : ''}"></span>
      </div>`;
    })
    .join('');
}

function channelOption(value: string, label: string, selected?: string): string {
  return `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`;
}

function partnerForm(p?: OutsourcePartner): string {
  const action = p ? `/admin/partners/${p.id}/update` : '/admin/partners/add';
  const ch = p?.preferredChannel ?? 'email';
  return `<form class="pcard" method="post" action="${action}" enctype="multipart/form-data">
    <div class="grid2">
      <label>Internal name<input name="name" placeholder="e.g. Harare Wide-Format Co." value="${esc(p?.name ?? '')}" required></label>
      <label>Short code<input name="shortCode" placeholder="e.g. HWF" value="${esc(p?.shortCode ?? '')}" required></label>
      <label>Contact email<input name="contactEmail" type="email" placeholder="orders@partner.co.zw" value="${esc(p?.contactEmail ?? '')}"></label>
      <label>WhatsApp number<input name="whatsappNumber" placeholder="+263…" value="${esc(p?.whatsappNumber ?? '')}"></label>
      <label>Portal URL<input name="portalUrl" placeholder="https://…" value="${esc(p?.portalUrl ?? '')}"></label>
      <label>Preferred channel<select name="preferredChannel">
        ${channelOption('email', 'Email (v1)', ch)}
        ${channelOption('whatsapp', 'WhatsApp', ch)}
        ${channelOption('portal', 'Portal', ch)}
      </select></label>
    </div>

    <div class="sizes">
      <div class="sub">Supported sizes &amp; wholesale price (what we pay them)</div>
      ${sizeRows(p)}
    </div>

    <label>Turnaround (internal)<input name="turnaround" placeholder="e.g. 2–3 working days" value="${esc(p?.turnaround ?? '')}"></label>
    <label>Notes<textarea name="notes" rows="2" placeholder="Pickup location, our account number, contact person…">${esc(p?.notes ?? '')}</textarea></label>

    <div class="flags">
      <label class="chk"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}> Active</label>
      <label class="chk"><input type="checkbox" name="isDefault" ${p?.isDefault ? 'checked' : ''}> Default partner</label>
    </div>

    <div class="actions">
      <button class="btn primary" type="submit">${p ? 'Save' : 'Add partner'}</button>
    </div>
  </form>
  ${p ? subActions(p) : ''}`;
}

/** Default / deactivate buttons live in their own forms (can't nest forms). */
function subActions(p: OutsourcePartner): string {
  const parts: string[] = [];
  if (!p.isDefault && p.active) {
    parts.push(`<form method="post" action="/admin/partners/${p.id}/default"><button class="btn" type="submit">Make default</button></form>`);
  }
  if (p.active) {
    parts.push(`<form method="post" action="/admin/partners/${p.id}/deactivate" onsubmit="return confirm('Deactivate ${esc(p.name)}? Existing orders are unaffected.')"><button class="btn del" type="submit">Deactivate</button></form>`);
  }
  return parts.length ? `<div class="subactions">${parts.join('')}</div>` : '';
}

function partnerCard(p: OutsourcePartner): string {
  const badges = [
    p.isDefault ? '<span class="badge badge-paid">Default</span>' : '',
    p.active ? '' : '<span class="badge badge-cancelled">Inactive</span>',
  ].join(' ');
  return `<div class="pwrap">
    <div class="phead"><strong>${esc(p.name)}</strong> <span class="mono">${esc(p.shortCode)}</span> ${badges}</div>
    ${partnerForm(p)}
  </div>`;
}

function pageHtml(partners: OutsourcePartner[], notice?: string): string {
  const extraCss = `
    .pwrap { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:18px; margin-bottom:14px; }
    .phead { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
    .phead .mono { color:var(--text2); font-size:12px; }
    .pcard label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--text2); margin-bottom:10px; }
    .pcard label input, .pcard label select, .pcard label textarea { color:var(--text); }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:0 14px; }
    .sizes { background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:12px; margin:6px 0 12px; }
    .size-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:4px 0; }
    .size-row .cost { color:var(--text2); font-size:13px; }
    .size-row .num { width:100px; }
    .chk { color:var(--text2); font-size:14px; display:flex; align-items:center; gap:6px; flex-direction:row !important; }
    .flags { display:flex; gap:20px; margin:6px 0 12px; }
    .actions { display:flex; gap:10px; }
    .subactions { display:flex; gap:10px; margin-top:10px; }
    .subactions form { margin:0; }
    @media (max-width:768px){ .grid2 { grid-template-columns:1fr; } }`;

  const body = `
  <div class="page-header">
    <h1>Outsource partners</h1>
    <div class="sub">Print shops that produce outsourced sizes (8×10 + wall art). Customer-invisible. The active <strong>default</strong> partner receives outsourced items automatically once auto-dispatch is live.</div>
  </div>
  ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}

  <h2>Partners</h2>
  ${partners.length ? partners.map(partnerCard).join('') : '<div class="sub">No partners yet — add one below.</div>'}

  <h2>Add a partner</h2>
  <div class="pwrap">${partnerForm()}</div>`;
  return adminShell({ active: 'partners', title: 'Outsource partners', body, role: 'full', extraCss });
}

async function parseFields(request: unknown): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const part of (request as { parts: () => AsyncIterable<{ type: string; fieldname?: string; value?: unknown }> }).parts()) {
    if (part.type !== 'file' && typeof part.fieldname === 'string') out[part.fieldname] = String(part.value ?? '');
  }
  return out;
}

export async function registerAdminPartners(app: FastifyInstance): Promise<void> {
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 0, fields: 100 } });
  }

  app.get('/admin/partners', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    const notice = (request.query as { msg?: string })?.msg;
    reply.type('text/html').send(pageHtml(await listPartners(), notice));
  });

  app.post('/admin/partners/add', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const input = normalizePartnerInput(await parseFields(request));
      if (!input.name || !input.shortCode) return reply.redirect('/admin/partners?msg=Name+and+short+code+required');
      await createPartner(input);
      return reply.redirect('/admin/partners?msg=Added');
    } catch (err) {
      logger.error({ err }, 'Failed to add outsource partner');
      return reply.redirect('/admin/partners?msg=Add+failed+(short+code+must+be+unique)');
    }
  });

  app.post('/admin/partners/:id/update', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const input = normalizePartnerInput(await parseFields(request));
      if (!input.name || !input.shortCode) return reply.redirect('/admin/partners?msg=Name+and+short+code+required');
      await updatePartner(id, input);
      return reply.redirect('/admin/partners?msg=Saved');
    } catch (err) {
      logger.error({ err }, 'Failed to update outsource partner');
      return reply.redirect('/admin/partners?msg=Save+failed');
    }
  });

  app.post('/admin/partners/:id/default', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await setDefaultPartner(id);
      return reply.redirect('/admin/partners?msg=Default+set');
    } catch (err) {
      logger.error({ err }, 'Failed to set default partner');
      return reply.redirect('/admin/partners?msg=Failed');
    }
  });

  app.post('/admin/partners/:id/deactivate', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await deactivatePartner(id);
      return reply.redirect('/admin/partners?msg=Deactivated');
    } catch (err) {
      logger.error({ err }, 'Failed to deactivate partner');
      return reply.redirect('/admin/partners?msg=Failed');
    }
  });
}
