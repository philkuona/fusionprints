/**
 * Self-hosted admin fonts.
 *
 * The admin pages used to pull their fonts from Google Fonts with a
 * render-blocking <link>/@import. On a flaky link to Google (common from ZW),
 * that request hangs and the browser shows a BLANK page until it resolves —
 * the "refresh several times before anything appears" bug.
 *
 * Serving the same bundled brand fonts from our own (fast, same-origin) backend
 * with `font-display: swap` removes the external dependency entirely: pages
 * render instantly in a system fallback and swap to the brand font when it
 * arrives. No Google round-trip, no blank page.
 */

import type { FastifyInstance } from 'fastify';
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
 * `@font-face` declarations pointing at the self-hosted files. Inject this at
 * the top of an admin page's <style> (replacing any Google Fonts import).
 * Variable fonts cover their full weight range; `swap` guarantees no blank text.
 */
export const ADMIN_FONT_CSS = `
@font-face { font-family: 'Fraunces'; src: url('/admin/assets/fonts/Fraunces.ttf') format('truetype'); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: 'Fraunces'; src: url('/admin/assets/fonts/Fraunces-Italic.ttf') format('truetype'); font-weight: 100 900; font-style: italic; font-display: swap; }
@font-face { font-family: 'Outfit'; src: url('/admin/assets/fonts/Outfit.ttf') format('truetype'); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: 'DM Sans'; src: url('/admin/assets/fonts/DMSans.ttf') format('truetype'); font-weight: 100 1000; font-style: normal; font-display: swap; }
@font-face { font-family: 'DM Mono'; src: url('/admin/assets/fonts/DMMono-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: 'DM Mono'; src: url('/admin/assets/fonts/DMMono-Medium.ttf') format('truetype'); font-weight: 500; font-style: normal; font-display: swap; }
`;

export async function registerAdminFonts(app: FastifyInstance): Promise<void> {
  app.get('/admin/assets/fonts/:file', async (request, reply) => {
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
  });
}
