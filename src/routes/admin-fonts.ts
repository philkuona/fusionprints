/**
 * Self-hosted brand fonts.
 *
 * Pages used to pull fonts from Google Fonts with a render-blocking <link>/
 * @import. On a flaky link to Google (common from ZW) that request hangs and the
 * browser shows a BLANK page until it resolves — the "refresh several times
 * before anything appears" bug.
 *
 * Serving the same bundled brand fonts from our own (fast, same-origin) backend
 * with `font-display: swap` removes the external dependency: pages render
 * instantly in a system fallback and swap to the brand font when it arrives.
 *
 * Files are served at the neutral `/assets/fonts/:file` (used by admin AND
 * customer-facing pages); `/admin/assets/fonts/:file` stays as an alias so any
 * older cached admin HTML keeps resolving.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { brandFontsDir } from '@/utils/fonts.js';

// Files we allow serving (whitelist — never join arbitrary user input onto a path).
const FONT_FILES = new Set([
  'Fraunces.ttf',
  'Fraunces-Italic.ttf',
  'Outfit.ttf',
  'DMMono-Regular.ttf',
  'DMMono-Medium.ttf',
  'DMSans.ttf',
]);

/**
 * `@font-face` declarations pointing at the self-hosted files. Inject at the top
 * of a page's <style> (replacing any Google Fonts import). Variable fonts cover
 * their full weight range; `swap` guarantees no blank text. DM Sans is only
 * pulled if a page actually uses it (unused @font-face = no fetch).
 */
export const BRAND_FONT_CSS = `
@font-face { font-family: 'Fraunces'; src: url('/assets/fonts/Fraunces.ttf') format('truetype'); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: 'Fraunces'; src: url('/assets/fonts/Fraunces-Italic.ttf') format('truetype'); font-weight: 100 900; font-style: italic; font-display: swap; }
@font-face { font-family: 'Outfit'; src: url('/assets/fonts/Outfit.ttf') format('truetype'); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: 'DM Sans'; src: url('/assets/fonts/DMSans.ttf') format('truetype'); font-weight: 100 1000; font-style: normal; font-display: swap; }
@font-face { font-family: 'DM Mono'; src: url('/assets/fonts/DMMono-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: 'DM Mono'; src: url('/assets/fonts/DMMono-Medium.ttf') format('truetype'); font-weight: 500; font-style: normal; font-display: swap; }
`;

/** Back-compat alias — admin pages import this name. */
export const ADMIN_FONT_CSS = BRAND_FONT_CSS;

async function serveFont(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { file } = request.params as { file: string };
  const safe = basename(file); // strip any path components
  if (!FONT_FILES.has(safe)) {
    reply.status(404).send({ error: 'Not found' });
    return;
  }
  try {
    const buf = await readFile(join(brandFontsDir(), safe));
    reply
      .header('Content-Type', 'font/ttf')
      // Immutable, long-lived — the filenames are stable per design.
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(buf);
  } catch {
    reply.status(404).send({ error: 'Not found' });
  }
}

// Brand favicon for the admin pages (served same-origin by the backend). The
// geometric mark from the wordmark, ink + malachite on a rounded cream tile.
const ADMIN_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#FBF7F0"/>
  <g transform="translate(15,10) scale(0.82)">
    <path d="M0 8 L12 0 L40 0 L40 14 L26 14 L14 22 L14 48 L0 48 Z" fill="#1F1B16"/>
    <path d="M14 22 L26 14 L40 14 L40 28 Z" fill="#05D668"/>
  </g>
</svg>`;

export async function registerAdminFonts(app: FastifyInstance): Promise<void> {
  app.get('/assets/fonts/:file', serveFont);
  app.get('/admin/assets/fonts/:file', serveFont); // alias for older cached admin HTML
  app.get('/admin/favicon.svg', async (_request, reply) => {
    reply
      .header('Content-Type', 'image/svg+xml')
      .header('Cache-Control', 'public, max-age=86400')
      .send(ADMIN_FAVICON_SVG);
  });
}
