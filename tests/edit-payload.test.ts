/**
 * edit-payload schema — the web-editor ↔ Sharp-applier contract
 * (audit IMP-1, wave 1).
 *
 * Accept/reject matrix for the canonical zod schema, plus cross-repo parity
 * checks against the web mirror (fusionprints-web/lib/edit/payload-schema.ts).
 * The mirror is intentionally a TS-interface re-expression (not a byte copy),
 * so parity is asserted on the load-bearing constants: EDIT_SCHEMA_VERSION
 * and AUTO_ENHANCE. The cross-repo tests skip when the sibling checkout is
 * absent (e.g. CI of this repo alone).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editPayloadSchema, EDIT_SCHEMA_VERSION } from '@/schemas/edit-payload.js';
import { AUTO_ENHANCE } from '@/services/edit-applier.js';

const VALID = {
  schemaVersion: EDIT_SCHEMA_VERSION,
  sourceImageId: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
  sizeCode: '4x6',
  crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8, orientation: 'portrait' as const },
};

describe('editPayloadSchema — accepts', () => {
  it('a minimal payload and fills the documented defaults', () => {
    const parsed = editPayloadSchema.parse(VALID);
    expect(parsed.rotate).toBe(0);
    expect(parsed.flipH).toBe(false);
    expect(parsed.flipV).toBe(false);
    expect(parsed.autoEnhance).toBe(false);
    expect(parsed.filterId).toBe('none');
    expect(parsed.border).toBe(false);
    expect(parsed.paper).toBe('glossy');
    expect(parsed.adjustments).toEqual({ brightness: 0, contrast: 0, saturation: 0, exposure: 0 });
  });

  it('a fully-specified payload', () => {
    const parsed = editPayloadSchema.parse({
      ...VALID,
      rotate: 270,
      flipH: true,
      flipV: true,
      adjustments: { brightness: -1, contrast: 1, saturation: 0.5, exposure: -2 },
      autoEnhance: true,
      filterId: 'sepia',
      border: true,
      paper: 'satin',
    });
    expect(parsed.rotate).toBe(270);
    expect(parsed.filterId).toBe('sepia');
  });

  it('boundary crop values (0 and 1)', () => {
    expect(() =>
      editPayloadSchema.parse({
        ...VALID,
        crop: { x: 0, y: 0, width: 1, height: 1, orientation: 'square' },
      }),
    ).not.toThrow();
  });
});

describe('editPayloadSchema — rejects', () => {
  it.each<[string, Record<string, unknown>]>([
    ['wrong schemaVersion', { ...VALID, schemaVersion: 2 }],
    ['non-uuid sourceImageId', { ...VALID, sourceImageId: 'not-a-uuid' }],
    ['malformed sizeCode', { ...VALID, sizeCode: '4by6' }],
    ['crop.x out of range', { ...VALID, crop: { ...VALID.crop, x: 1.5 } }],
    ['negative crop.width', { ...VALID, crop: { ...VALID.crop, width: -0.1 } }],
    ['unknown crop orientation', { ...VALID, crop: { ...VALID.crop, orientation: 'diagonal' } }],
    ['rotate 45', { ...VALID, rotate: 45 }],
    ['exposure beyond 2 stops', { ...VALID, adjustments: { brightness: 0, contrast: 0, saturation: 0, exposure: 3 } }],
    ['brightness beyond 1', { ...VALID, adjustments: { brightness: 2, contrast: 0, saturation: 0, exposure: 0 } }],
    ['unknown filterId', { ...VALID, filterId: 'cool' }],
    ['unknown paper', { ...VALID, paper: 'matte' }],
    ['unknown extra key (strict)', { ...VALID, hax: true }],
  ])('%s', (_label, payload) => {
    expect(editPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

// ── Cross-repo parity with the web mirror ──────────────────────────────────

const WEB_MIRROR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'fusionprints-web', 'lib', 'edit', 'payload-schema.ts',
);

describe.skipIf(!existsSync(WEB_MIRROR))('web mirror parity', () => {
  const src = existsSync(WEB_MIRROR) ? readFileSync(WEB_MIRROR, 'utf8') : '';

  it('EDIT_SCHEMA_VERSION matches', () => {
    const m = src.match(/EDIT_SCHEMA_VERSION\s*=\s*(\d+)/);
    expect(m, 'EDIT_SCHEMA_VERSION not found in web mirror').toBeTruthy();
    expect(Number(m![1])).toBe(EDIT_SCHEMA_VERSION);
  });

  it('AUTO_ENHANCE nudges match the server applier', () => {
    const m = src.match(/AUTO_ENHANCE[^=]*=\s*{([^}]*)}/);
    expect(m, 'AUTO_ENHANCE not found in web mirror').toBeTruthy();
    const web: Record<string, number> = {};
    for (const [, key, value] of m![1].matchAll(/(\w+):\s*([\d.-]+)/g)) {
      web[key] = Number(value);
    }
    expect(web).toEqual(AUTO_ENHANCE);
  });
});
