/**
 * Brand-font bootstrap for server-side rendering.
 *
 * Sharp renders our SVG slips through its bundled librsvg → pango → fontconfig
 * stack. That fontconfig does NOT know about our brand fonts (Fraunces, Outfit,
 * DM Mono) unless we point it at them, so without this the slips fall back to
 * generic Georgia/DejaVu and look nothing like the approved designs.
 *
 * We ship the font files in `assets/fonts/` (committed) and, at startup, write a
 * minimal fontconfig config that adds that directory, then export its path via
 * FONTCONFIG_FILE. fontconfig reads that env var when it first initialises
 * (lazily, on the first text render), so this must run BEFORE any slip render.
 * No root or system font install needed — works the same in dev and on prod.
 */

import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@/utils/logger.js';

let registered = false;

/** Absolute path to the bundled brand-font directory (repo-root/assets/fonts). */
export function brandFontsDir(): string {
  // This file lives at <root>/src/utils/fonts.ts → up two levels to <root>.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'assets', 'fonts');
}

/**
 * Make the bundled brand fonts available to Sharp/librsvg. Idempotent and
 * best-effort: a failure here must never crash the server, only degrade slip
 * fonts back to the system fallback.
 */
export function registerBrandFonts(): void {
  if (registered) return;
  registered = true;

  try {
    const fontsDir = brandFontsDir();
    if (!existsSync(fontsDir)) {
      logger.warn({ fontsDir }, 'Brand fonts directory missing — slips will use fallback fonts');
      return;
    }

    const cacheDir = mkdtempSync(join(tmpdir(), 'fp-fontcache-'));
    const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <cachedir>${cacheDir}</cachedir>
  <!-- Keep system fonts as a fallback for any glyph our brand fonts lack. -->
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>
`;
    const confPath = join(cacheDir, 'fonts.conf');
    writeFileSync(confPath, conf, 'utf8');

    process.env.FONTCONFIG_FILE = confPath;
    logger.info({ fontsDir, confPath }, 'Registered brand fonts for SVG rendering');
  } catch (err) {
    logger.warn({ err }, 'Failed to register brand fonts — slips will use fallback fonts');
  }
}
