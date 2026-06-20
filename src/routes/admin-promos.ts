/**
 * Admin — Promo campaigns.
 *
 * A small admin screen to manage the two promo cards that print with every
 * order (see docs/slip-system.md). Each campaign holds two slots; each slot is
 * a kind (referral | upsell) + a pre-rendered 4x6 card PNG uploaded here and
 * stored in B2 under campaigns/. Exactly one campaign is active at a time;
 * order.ts queues the active campaign's two cards on each paid order.
 *
 * Replaces the one-off seed script. Full-admin only.
 *
 *   GET  /admin/promos                  — list + create form
 *   POST /admin/promos                  — create a campaign (multipart, 2 images)
 *   POST /admin/promos/:id/activate     — make this the active campaign
 *   POST /admin/promos/:id/delete       — delete a campaign
 */

import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { promoCampaigns, type PromoSlot } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { getSignedImageUrl } from '@/services/image-storage.js';
import { requireFullAdmin, requireFullAdminPage } from '@/utils/auth.js';
import { adminShell } from '@/routes/admin-theme.js';

const s3 = new S3Client({
  endpoint: `https://${env.B2_ENDPOINT}`,
  region: 'auto',
  credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APPLICATION_KEY },
});

async function uploadCampaignImage(buf: Buffer, mimetype: string): Promise<string> {
  const ext = mimetype === 'image/jpeg' ? 'jpg' : 'png';
  const key = `campaigns/${randomUUID()}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key,
      Body: buf,
      ContentType: mimetype || 'image/png',
    }),
  );
  return key;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function pageHtml(notice?: string): Promise<string> {
  const campaigns = await db.select().from(promoCampaigns).orderBy(promoCampaigns.createdAt);

  const rows = await Promise.all(
    campaigns.map(async (c) => {
      const slotHtml = await Promise.all(
        [c.slot1, c.slot2].map(async (s, i) => {
          const slot = s as PromoSlot;
          const preview = slot?.imageKey ? await getSignedImageUrl(slot.imageKey, 600).catch(() => null) : null;
          return `<div class="slot">
            <div class="slot-h">Slot ${i + 1} · <b>${esc(slot?.kind ?? '?')}</b></div>
            ${preview ? `<img src="${esc(preview)}" alt="slot ${i + 1}">` : '<div class="noimg">no image</div>'}
            ${slot?.headline ? `<div class="copy">${esc(slot.headline)}</div>` : ''}
          </div>`;
        }),
      );
      return `<div class="card ${c.active ? 'active' : ''}">
        <div class="card-head">
          <div><b>${esc(c.name)}</b> ${c.active ? '<span class="badge">ACTIVE</span>' : ''}</div>
          <div class="actions">
            ${c.active ? '' : `<form method="post" action="/admin/promos/${c.id}/activate"><button class="btn">Set active</button></form>`}
            <form method="post" action="/admin/promos/${c.id}/delete" onsubmit="return confirm('Delete this campaign?')"><button class="btn danger">Delete</button></form>
          </div>
        </div>
        <div class="slots">${slotHtml.join('')}</div>
      </div>`;
    }),
  );

  const extraCss = `
    main .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:14px; }
    main .card.active { border-color:var(--accent); }
    .card-head { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
    .card-head .badge { background:var(--accent); color:#0a3d22; font-size:11px; font-weight:700; padding:2px 9px; border-radius:999px; margin-left:6px; }
    .actions { display:flex; gap:8px; }
    .actions form { margin:0; }
    .slots { display:flex; gap:14px; margin-top:14px; flex-wrap:wrap; }
    .slot { background:var(--surface2); border-radius:10px; padding:10px; width:200px; }
    .slot-h { font-size:12px; color:var(--text2); margin-bottom:8px; }
    .slot img { width:100%; aspect-ratio:2/3; object-fit:cover; border-radius:6px; background:#1f1b16; }
    .noimg { width:100%; aspect-ratio:2/3; display:flex; align-items:center; justify-content:center; color:var(--text2); background:var(--surface); border:1px dashed var(--border); border-radius:6px; font-size:12px; }
    .copy { font-size:12px; color:var(--text2); margin-top:6px; }
    form.create { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:18px; margin-top:8px; }
    form.create label { display:block; font-size:12px; color:var(--text2); margin:12px 0 4px; }
    form.create input[type=text], form.create select, form.create input[type=file] { width:100%; max-width:420px; }
    .slot-fields { display:flex; gap:24px; flex-wrap:wrap; margin-top:8px; }
    .slot-col { flex:1 1 280px; border-top:1px solid var(--border); padding-top:8px; }
    .hint { color:var(--text2); font-size:12px; margin-top:6px; }`;

  const body = `
  <div class="page-header">
    <h1>Promo campaigns</h1>
    <div class="sub">Two cards print with every order. Upload pre-rendered 4×6 PNGs (1200×1800). One campaign is active at a time.</div>
  </div>
  ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}

  ${rows.join('') || '<div class="sub">No campaigns yet. Create one below.</div>'}

  <h1 style="margin-top:28px">New campaign</h1>
  <form class="create" method="post" action="/admin/promos" enctype="multipart/form-data">
    <label>Campaign name</label>
    <input type="text" name="name" placeholder="e.g. Launch — referral + wall art" required>
    <div class="slot-fields">
      ${[1, 2].map((n) => `<div class="slot-col">
        <b>Slot ${n}</b>
        <label>Kind</label>
        <select name="slot${n}Kind"><option value="referral">referral</option><option value="upsell"${n === 2 ? ' selected' : ''}>upsell</option></select>
        <label>Headline (optional, reference)</label>
        <input type="text" name="slot${n}Headline" placeholder="e.g. Print it bigger.">
        <label>Card image (4×6 PNG, 1200×1800)</label>
        <input type="file" name="slot${n}Image" accept="image/png,image/jpeg" required>
      </div>`).join('')}
    </div>
    <div class="hint">New campaigns are created inactive. Use “Set active” to switch the live cards.</div>
    <div style="margin-top:16px"><button class="btn primary" type="submit">Create campaign</button></div>
  </form>`;
  return adminShell({ active: 'promos', title: 'Promo campaigns', body, role: 'full', extraCss });
}

export async function registerAdminPromos(app: FastifyInstance): Promise<void> {
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, {
      limits: { fileSize: 25 * 1024 * 1024, files: 2 },
    });
  }

  // GET /admin/promos — page
  app.get('/admin/promos', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    const notice = (request.query as { msg?: string })?.msg;
    reply.type('text/html').send(await pageHtml(notice));
  });

  // POST /admin/promos — create campaign (multipart)
  app.post('/admin/promos', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const fields: Record<string, string> = {};
      const fileBufs: Record<string, { buf: Buffer; mimetype: string }> = {};

      for await (const part of (request as any).parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (buf.length > 0) fileBufs[part.fieldname] = { buf, mimetype: part.mimetype };
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }

      const name = (fields.name ?? '').trim();
      if (!name) return reply.redirect('/admin/promos?msg=Name+is+required');
      if (!fileBufs.slot1Image || !fileBufs.slot2Image) {
        return reply.redirect('/admin/promos?msg=Both+slot+images+are+required');
      }

      const slot1Key = await uploadCampaignImage(fileBufs.slot1Image.buf, fileBufs.slot1Image.mimetype);
      const slot2Key = await uploadCampaignImage(fileBufs.slot2Image.buf, fileBufs.slot2Image.mimetype);

      const mkSlot = (n: number, key: string): PromoSlot => ({
        kind: fields[`slot${n}Kind`] === 'referral' ? 'referral' : 'upsell',
        imageKey: key,
        headline: (fields[`slot${n}Headline`] ?? '').trim() || undefined,
      });

      await db.insert(promoCampaigns).values({
        name,
        active: false,
        slot1: mkSlot(1, slot1Key),
        slot2: mkSlot(2, slot2Key),
      });

      logger.info({ name }, 'Promo campaign created');
      return reply.redirect('/admin/promos?msg=Campaign+created+(inactive)');
    } catch (err) {
      logger.error({ err }, 'Failed to create promo campaign');
      return reply.redirect('/admin/promos?msg=Create+failed');
    }
  });

  // POST /admin/promos/:id/activate
  app.post('/admin/promos/:id/activate', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    try {
      await db.update(promoCampaigns).set({ active: false });
      await db.update(promoCampaigns).set({ active: true, updatedAt: new Date() }).where(eq(promoCampaigns.id, id));
      logger.info({ id }, 'Promo campaign activated');
      return reply.redirect('/admin/promos?msg=Campaign+activated');
    } catch (err) {
      logger.error({ err, id }, 'Failed to activate promo campaign');
      return reply.redirect('/admin/promos?msg=Activate+failed');
    }
  });

  // POST /admin/promos/:id/delete
  app.post('/admin/promos/:id/delete', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    try {
      await db.delete(promoCampaigns).where(eq(promoCampaigns.id, id));
      logger.info({ id }, 'Promo campaign deleted');
      return reply.redirect('/admin/promos?msg=Campaign+deleted');
    } catch (err) {
      logger.error({ err, id }, 'Failed to delete promo campaign');
      return reply.redirect('/admin/promos?msg=Delete+failed');
    }
  });
}
