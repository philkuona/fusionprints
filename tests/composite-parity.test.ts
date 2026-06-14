/**
 * Composite catalog parity (audit IMP-3).
 *
 * The backend catalog (config/catalog.ts) is the single source of truth for
 * composite geometry + price; the web keeps a local copy in
 * lib/composite-products.ts so the editor can render at print scale offline,
 * and /web/api/composites serves the same data at runtime. This test fails if
 * the web copy drifts from the backend on any parity-critical field — the
 * geometry MUST match or the printed sheet won't match the preview.
 *
 * Skips when the sibling web checkout isn't present (e.g. CI of this repo
 * alone). The web file is pure data (no imports), so a direct import works.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProduct } from '@/config/catalog.js';

const WEB_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'fusionprints-web', 'lib', 'composite-products.ts',
);

// web slug -> backend sizeCode
const PAIRS: [string, string][] = [
  ['wallet', 'wallet_4up'],
  ['passport', 'passport_6up'],
  ['mini', 'mini_pair'],
];

describe.skipIf(!existsSync(WEB_FILE))('composite catalog parity (web mirror vs backend)', () => {
  it.each(PAIRS)('%s matches the backend catalog geometry + price', async (slug, sizeCode) => {
    const { COMPOSITE_PRODUCTS } = (await import(WEB_FILE)) as {
      COMPOSITE_PRODUCTS: Record<string, {
        sizeCode: string;
        priceUsd: number;
        uniquePhotos: number;
        layout: {
          sheetWidth: number; sheetHeight: number; printRotation: number;
          cells: { x: number; y: number; width: number; height: number }[];
        };
      }>;
    };

    const web = COMPOSITE_PRODUCTS[slug];
    const backend = getProduct(sizeCode);
    expect(web, `web has ${slug}`).toBeTruthy();
    expect(backend?.layout, `backend has ${sizeCode} layout`).toBeTruthy();
    const bl = backend!.layout!;

    expect(web.sizeCode).toBe(sizeCode);
    expect(web.priceUsd).toBe(backend!.unitPriceUsd);
    expect(web.uniquePhotos).toBe(bl.photosRequired);
    expect(web.layout.sheetWidth).toBe(bl.sheetWidth);
    expect(web.layout.sheetHeight).toBe(bl.sheetHeight);
    expect(web.layout.printRotation).toBe(bl.printRotation);

    // Cell geometry, in order (photoIndex is backend-only render detail).
    const webCells = web.layout.cells.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height }));
    const backendCells = bl.cells.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height }));
    expect(webCells).toEqual(backendCells);
  });

  it('covers every backend composite (no web-missing product)', async () => {
    const { COMPOSITE_PRODUCTS } = (await import(WEB_FILE)) as {
      COMPOSITE_PRODUCTS: Record<string, { sizeCode: string }>;
    };
    const webSizeCodes = new Set(Object.values(COMPOSITE_PRODUCTS).map((p) => p.sizeCode));
    for (const [, sizeCode] of PAIRS) {
      expect(webSizeCodes.has(sizeCode), `web mirrors ${sizeCode}`).toBe(true);
    }
  });
});
