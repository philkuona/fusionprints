/**
 * Web photo-import routes — /web/api/imports/*
 *
 * POST /web/api/imports/from-urls         — import photos from URLs (Dropbox Chooser)
 * GET  /web/api/imports/google/start      — begin Google Photos picker (OAuth → picker)
 * GET  /web/api/imports/google/callback   — OAuth callback → create picker session
 * POST /web/api/imports/google/poll       — poll picker; download + store picked photos
 *
 * Imported photos are stored exactly like device uploads (storeWebImage) so they
 * flow into the rest of the editor/cart unchanged.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { authenticateWebUser } from '@/utils/web-auth.js';
import { storeWebImage } from '@/services/image-storage.js';
import {
  isEnabled as googleEnabled,
  getPickerAuthorizationUrl,
  exchangeCodeForAccessToken,
  createPickerSession,
  isSessionReady,
  listPickedMedia,
  downloadPickedMedia,
  deletePickerSession,
} from '@/services/google-photos.js';

const MAX_BYTES = 50 * 1024 * 1024;

const fromUrlsSchema = z.object({
  files: z
    .array(z.object({ url: z.string().url(), filename: z.string().max(200).optional() }))
    .min(1)
    .max(30),
});

/** SSRF guard: only allow Dropbox-hosted https links (the Chooser's source). */
function isAllowedDropboxUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'dropbox.com' || u.hostname.endsWith('.dropbox.com') || u.hostname.endsWith('.dropboxusercontent.com');
  } catch {
    return false;
  }
}

export async function registerWebImportRoutes(app: FastifyInstance): Promise<void> {
  // GET /web/api/imports/config — which cloud-import options are available.
  // Runtime feature flags so the frontend shows/hides options without a rebuild.
  app.get('/web/api/imports/config', async (_request, reply) => {
    return reply.send({
      googlePhotos: env.GOOGLE_PHOTOS_IMPORT_ENABLED && googleEnabled(),
      dropboxAppKey: env.DROPBOX_APP_KEY || null,
    });
  });

  // POST /web/api/imports/from-urls — Dropbox Chooser links
  app.post('/web/api/imports/from-urls', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const parsed = fromUrlsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', issues: parsed.error.flatten().fieldErrors });
    }

    const photos = [];
    for (const f of parsed.data.files) {
      if (!isAllowedDropboxUrl(f.url)) {
        logger.warn({ userId, url: f.url }, 'Rejected non-Dropbox import URL');
        continue;
      }
      try {
        const res = await fetch(f.url);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_BYTES) continue;
        const ct = res.headers.get('content-type') ?? 'image/jpeg';
        const stored = await storeWebImage(buf, userId, ct, f.filename ?? 'dropbox-photo.jpg');
        if (stored) photos.push(stored);
      } catch (err) {
        logger.warn({ userId, err }, 'Failed to import a Dropbox URL');
      }
    }

    return reply.send({ photos });
  });

  // GET /web/api/imports/google/start — kick off the picker OAuth (in a popup)
  app.get('/web/api/imports/google/start', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;
    if (!googleEnabled()) {
      return reply.redirect(`${env.WEB_URL}/account/photos?import=google_disabled`);
    }
    const state = crypto.randomBytes(16).toString('hex');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (request as any).session.googlePickerState = state;
    return reply.redirect(getPickerAuthorizationUrl(state));
  });

  // GET /web/api/imports/google/callback — exchange code, open the picker
  app.get('/web/api/imports/google/callback', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = (request as any).session;
    const expected = session.googlePickerState;
    delete session.googlePickerState;

    if (error || !code || !state || state !== expected) {
      logger.warn({ error, stateMatch: state === expected }, 'Google picker callback rejected');
      return reply.redirect(`${env.WEB_URL}/account/photos?import=google_error`);
    }

    try {
      const accessToken = await exchangeCodeForAccessToken(code);
      const picker = await createPickerSession(accessToken);
      session.googlePicker = { accessToken, sessionId: picker.id };
      return reply.redirect(picker.pickerUri);
    } catch (err) {
      logger.error({ err }, 'Google picker setup failed');
      return reply.redirect(`${env.WEB_URL}/account/photos?import=google_error`);
    }
  });

  // POST /web/api/imports/google/poll — has the user finished picking?
  app.post('/web/api/imports/google/poll', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = (request as any).session;
    const picker = session.googlePicker as { accessToken: string; sessionId: string } | undefined;
    if (!picker) return reply.send({ status: 'idle' });

    try {
      const ready = await isSessionReady(picker.accessToken, picker.sessionId);
      if (!ready) return reply.send({ status: 'pending' });

      const media = await listPickedMedia(picker.accessToken, picker.sessionId);
      const photos = [];
      for (const m of media) {
        try {
          const buf = await downloadPickedMedia(picker.accessToken, m.baseUrl);
          if (buf.length === 0 || buf.length > MAX_BYTES) continue;
          const stored = await storeWebImage(buf, userId, m.mimeType, m.filename);
          if (stored) photos.push(stored);
        } catch (err) {
          logger.warn({ userId, err }, 'Failed to import a Google Photos item');
        }
      }

      await deletePickerSession(picker.accessToken, picker.sessionId);
      delete session.googlePicker;
      logger.info({ userId, count: photos.length }, 'Imported photos from Google Photos');
      return reply.send({ status: 'done', photos });
    } catch (err) {
      logger.error({ userId, err }, 'Google picker poll failed');
      delete session.googlePicker;
      return reply.status(500).send({ status: 'error' });
    }
  });
}
