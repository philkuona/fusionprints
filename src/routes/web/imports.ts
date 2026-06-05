/**
 * Web photo-import routes — /web/api/imports/*
 *
 * GET  /web/api/imports/google/start      — begin Google Photos picker (OAuth → picker)
 * GET  /web/api/imports/google/callback   — OAuth callback → create picker session
 * POST /web/api/imports/google/poll       — poll picker; download + store picked photos
 *
 * Imported photos are stored exactly like device uploads (storeWebImage) so they
 * flow into the rest of the editor/cart unchanged.
 */

import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { authenticateWebUser } from '@/utils/web-auth.js';
import { storeWebImage, getSignedImageUrl } from '@/services/image-storage.js';
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

type StoredImage = NonNullable<Awaited<ReturnType<typeof storeWebImage>>>;

/** Shape stored photos the same way the upload route does: id + a SIGNED url. */
async function toApiPhoto(stored: StoredImage) {
  return {
    id: stored.imageId,
    storageUrl: await getSignedImageUrl(stored.storageKey),
    widthPx: stored.widthPx,
    heightPx: stored.heightPx,
    fileSizeBytes: stored.fileSizeBytes,
    format: stored.format,
  };
}

export async function registerWebImportRoutes(app: FastifyInstance): Promise<void> {
  // GET /web/api/imports/config — which cloud-import options are available.
  // Runtime feature flags so the frontend shows/hides options without a rebuild.
  app.get('/web/api/imports/config', async (_request, reply) => {
    return reply.send({
      googlePhotos: env.GOOGLE_PHOTOS_IMPORT_ENABLED && googleEnabled(),
    });
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

      // Claim the session immediately so an overlapping/duplicate poll can't
      // re-import the same selection while this one downloads.
      delete session.googlePicker;

      const media = await listPickedMedia(picker.accessToken, picker.sessionId);
      const photos = [];
      for (const m of media) {
        try {
          const buf = await downloadPickedMedia(picker.accessToken, m.baseUrl);
          if (buf.length === 0 || buf.length > MAX_BYTES) continue;
          const stored = await storeWebImage(buf, userId, m.mimeType, m.filename);
          if (stored) photos.push(await toApiPhoto(stored));
        } catch (err) {
          logger.warn({ userId, err }, 'Failed to import a Google Photos item');
        }
      }

      await deletePickerSession(picker.accessToken, picker.sessionId);
      logger.info({ userId, count: photos.length }, 'Imported photos from Google Photos');
      return reply.send({ status: 'done', photos });
    } catch (err) {
      logger.error({ userId, err }, 'Google picker poll failed');
      delete session.googlePicker;
      return reply.status(500).send({ status: 'error' });
    }
  });
}
