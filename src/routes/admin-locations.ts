/**
 * Admin — Collection points (pickup locations).
 *
 * Add/edit/activate/delete the locations customers can collect from. The primary
 * (lowest sort-order among active) is surfaced across channels. Full-admin only.
 *
 *   GET  /admin/locations              — list + add/edit forms
 *   POST /admin/locations/add          — create a point
 *   POST /admin/locations/:id/update   — edit a point
 *   POST /admin/locations/:id/delete   — remove a point
 */
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { logger } from '@/utils/logger.js';
import { requireFullAdmin, requireFullAdminPage } from '@/utils/auth.js';
import {
  listCollectionPoints,
  createCollectionPoint,
  updateCollectionPoint,
  deleteCollectionPoint,
} from '@/services/collection-points.js';
import type { CollectionPoint } from '@/db/schema.js';

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function row(p?: CollectionPoint): string {
  const action = p ? `/admin/locations/${p.id}/update` : '/admin/locations/add';
  const checked = !p || p.active ? 'checked' : '';
  return `<form class="pt" method="post" action="${action}" enctype="multipart/form-data">
    <input name="name" placeholder="Name (e.g. Fusion Prints Lab)" value="${esc(p?.name ?? '')}" required>
    <input name="address" placeholder="Address" value="${esc(p?.addressLine ?? '')}" required>
    <input name="hours" placeholder="Hours (optional)" value="${esc(p?.hours ?? '')}">
    <input class="num" name="sort" type="number" value="${p?.sortOrder ?? 0}" title="Sort order">
    <label class="chk"><input type="checkbox" name="active" ${checked}> Active</label>
    <button class="btn" type="submit">${p ? 'Save' : 'Add'}</button>
    ${p ? `</form><form method="post" action="/admin/locations/${p.id}/delete" onsubmit="return confirm('Delete this point?')"><button class="btn del" type="submit">Delete</button>` : ''}
  </form>`;
}

function pageHtml(points: CollectionPoint[], notice?: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Collection points — FusionPrints admin</title>
<style>
  :root { --bg:#16130f; --surface:#211d17; --surface2:#2b261e; --text:#f3ede2; --mute:#9b8f7c; --accent:#05D668; --red:#ef4444; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui,sans-serif; padding:24px; }
  a { color:var(--accent); }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:13px; color:var(--mute); text-transform:uppercase; letter-spacing:.05em; margin:22px 0 8px; }
  .sub { color:var(--mute); font-size:13px; margin-bottom:8px; }
  .notice { background:var(--accent); color:#13110d; padding:10px 14px; border-radius:8px; margin-bottom:16px; font-weight:600; }
  .pt { display:flex; gap:8px; align-items:center; flex-wrap:wrap; background:var(--surface); padding:12px; border-radius:10px; margin-bottom:10px; }
  input[type=text], input:not([type]), input[type=number] { padding:8px 10px; background:var(--surface2); border:1px solid #ffffff22; border-radius:8px; color:var(--text); font-size:14px; }
  input:not(.num) { flex:1; min-width:140px; } .num { width:70px; }
  input:focus { outline:none; border-color:var(--accent); }
  .chk { color:var(--mute); font-size:13px; display:flex; align-items:center; gap:5px; }
  .btn { cursor:pointer; background:var(--accent); color:#13110d; border:none; border-radius:8px; padding:9px 16px; font-size:14px; font-weight:700; }
  .btn.del { background:transparent; color:var(--red); border:1px solid var(--red); }
</style></head>
<body>
  <p style="margin:0 0 10px"><a href="/admin">&larr; Admin</a></p>
  <h1>Collection points</h1>
  <div class="sub">Pickup locations shown to customers. The primary (lowest sort, active) is used where one location is shown.</div>
  ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}

  <h2>Existing</h2>
  ${points.length ? points.map((p) => row(p)).join('') : '<div class="sub">No collection points yet — add one below.</div>'}

  <h2>Add a point</h2>
  ${row()}
</body></html>`;
}

async function parseFields(request: unknown): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const part of (request as { parts: () => AsyncIterable<{ type: string; fieldname?: string; value?: unknown }> }).parts()) {
    if (part.type !== 'file' && typeof part.fieldname === 'string') out[part.fieldname] = String(part.value ?? '');
  }
  return out;
}

export async function registerAdminLocations(app: FastifyInstance): Promise<void> {
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 0, fields: 100 } });
  }

  app.get('/admin/locations', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    const notice = (request.query as { msg?: string })?.msg;
    reply.type('text/html').send(pageHtml(await listCollectionPoints(), notice));
  });

  app.post('/admin/locations/add', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const f = await parseFields(request);
      await createCollectionPoint({
        name: f.name?.trim(),
        addressLine: f.address?.trim(),
        hours: f.hours?.trim() || null,
        active: f.active === 'on',
        sortOrder: Number(f.sort) || 0,
      });
      return reply.redirect('/admin/locations?msg=Added');
    } catch (err) {
      logger.error({ err }, 'Failed to add collection point');
      return reply.redirect('/admin/locations?msg=Add+failed');
    }
  });

  app.post('/admin/locations/:id/update', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const f = await parseFields(request);
      await updateCollectionPoint(id, {
        name: f.name?.trim(),
        addressLine: f.address?.trim(),
        hours: f.hours?.trim() || null,
        active: f.active === 'on',
        sortOrder: Number(f.sort) || 0,
      });
      return reply.redirect('/admin/locations?msg=Saved');
    } catch (err) {
      logger.error({ err }, 'Failed to update collection point');
      return reply.redirect('/admin/locations?msg=Save+failed');
    }
  });

  app.post('/admin/locations/:id/delete', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await deleteCollectionPoint(id);
      return reply.redirect('/admin/locations?msg=Deleted');
    } catch (err) {
      logger.error({ err }, 'Failed to delete collection point');
      return reply.redirect('/admin/locations?msg=Delete+failed');
    }
  });
}
