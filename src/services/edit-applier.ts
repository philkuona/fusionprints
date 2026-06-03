/**
 * Edit applier (Phase 2.2, S5). Turns an EditPayload + the original image into a
 * print-ready render with Sharp. The geometry (rotate → flip → crop) and colour
 * math here are the SERVER half of the preview↔print parity contract; the web
 * editor's live preview must use the identical formulas (see the client shader +
 * editor-canvas). Operation order is fixed and must not change without updating
 * both sides.
 *
 * Colour model (normalized sRGB):
 *   exposure (×2^e) + brightness (+b) + contrast (pivot .5) collapse to one
 *   affine  out = c*A + B   →  sharp.linear(A, B*255)
 *   saturation = Rec.709 luma-weighted matrix  →  sharp.recomb
 *   filter    = fixed 3×3 matrix               →  folded into the same recomb
 */

import sharp from 'sharp';
import { createHash } from 'crypto';
import type { EditPayload } from '@/schemas/edit-payload.js';
import type { Product } from '@/config/catalog.js';

export const REC709 = [0.2126, 0.7152, 0.0722] as const;

// Deterministic auto-enhance nudges (added before the user's adjustments) so the
// toggle round-trips through the payload and stays parity-safe.
export const AUTO_ENHANCE = { brightness: 0.05, contrast: 0.1, saturation: 0.08, exposure: 0 };

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

// Fixed colour matrices for the filters (applied to sRGB rgb). Must match the
// client shader exactly.
export const FILTER_MATRICES: Record<EditPayload['filterId'], Mat3 | null> = {
  none: null,
  bw: [
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
  ],
  sepia: [
    [0.393, 0.769, 0.189],
    [0.349, 0.686, 0.168],
    [0.272, 0.534, 0.131],
  ],
  vintage: [
    [0.62, 0.32, 0.06],
    [0.11, 0.74, 0.05],
    [0.1, 0.18, 0.66],
  ],
};

function satMatrix(s: number): Mat3 {
  const [lr, lg, lb] = REC709;
  return [
    [(1 - s) * lr + s, (1 - s) * lg, (1 - s) * lb],
    [(1 - s) * lr, (1 - s) * lg + s, (1 - s) * lb],
    [(1 - s) * lr, (1 - s) * lg, (1 - s) * lb + s],
  ];
}

function mat3mul(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return out as Mat3;
}

function isIdentity(m: Mat3): boolean {
  const id = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) if (Math.abs(m[i][j] - id[i][j]) > 1e-4) return false;
  return true;
}

/** Oriented print dimensions in inches for a sizeCode + orientation. */
function orientedInches(sizeCode: string, orientation: EditPayload['crop']['orientation']): [number, number] {
  const [a, b] = sizeCode.split('x').map(Number);
  const small = Math.min(a, b);
  const large = Math.max(a, b);
  if (orientation === 'square') return [a, b];
  return orientation === 'landscape' ? [large, small] : [small, large];
}

/** Oriented pixel target from the (portrait-stored) recommended resolution. */
function orientedTarget(
  rec: { width: number; height: number },
  orientation: EditPayload['crop']['orientation'],
): { w: number; h: number } {
  if (orientation === 'landscape') return { w: rec.height, h: rec.width };
  return { w: rec.width, h: rec.height };
}

/** Short, stable hash of a payload — used for the idempotent storage key. */
export function payloadHash(payload: EditPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export interface AppliedImage {
  buffer: Buffer;
  width: number;
  height: number;
  format: 'jpeg';
}

/**
 * Apply an edit payload to an original image buffer, producing a print-ready
 * JPEG at the size's recommended resolution.
 */
export async function applyEdit(
  buffer: Buffer,
  payload: EditPayload,
  product: Product,
): Promise<AppliedImage> {
  const meta = await sharp(buffer).metadata();
  const ow = meta.width ?? 0;
  const oh = meta.height ?? 0;
  if (ow === 0 || oh === 0) throw new Error('Source image has no dimensions');

  const { rotate, flipH, flipV, crop } = payload;
  // Dimensions after rotation (flip preserves dims). Crop is normalized against
  // this rotated+flipped space — matching the client's pre-rotated preview.
  const rotW = rotate === 90 || rotate === 270 ? oh : ow;
  const rotH = rotate === 90 || rotate === 270 ? ow : oh;

  let cw = Math.max(1, Math.min(Math.round(crop.width * rotW), rotW));
  let ch = Math.max(1, Math.min(Math.round(crop.height * rotH), rotH));
  let left = Math.max(0, Math.min(Math.round(crop.x * rotW), rotW - cw));
  let top = Math.max(0, Math.min(Math.round(crop.y * rotH), rotH - ch));

  let img = sharp(buffer).rotate(rotate);
  if (flipH) img = img.flop();
  if (flipV) img = img.flip();
  img = img.extract({ left, top, width: cw, height: ch });

  // ── Colour ──
  const ae = payload.autoEnhance ? AUTO_ENHANCE : { brightness: 0, contrast: 0, saturation: 0, exposure: 0 };
  const brightness = payload.adjustments.brightness + ae.brightness;
  const contrast = payload.adjustments.contrast + ae.contrast;
  const saturation = payload.adjustments.saturation + ae.saturation;
  const exposure = payload.adjustments.exposure + ae.exposure;

  const A = Math.pow(2, exposure) * (1 + contrast);
  const B = brightness * (1 + contrast) + 0.5 * (1 - (1 + contrast));
  if (Math.abs(A - 1) > 1e-4 || Math.abs(B) > 1e-4) img = img.linear(A, B * 255);

  let M = satMatrix(1 + saturation);
  const fm = FILTER_MATRICES[payload.filterId];
  if (fm) M = mat3mul(fm, M);
  if (!isIdentity(M)) img = img.recomb(M);

  // ── Resize to print target (+ optional ½" white border) ──
  const target = orientedTarget(product.recommendedResolution, crop.orientation);
  if (payload.border) {
    const [pw] = orientedInches(payload.sizeCode, crop.orientation);
    const dpi = target.w / pw;
    const m = Math.max(1, Math.round(0.5 * dpi));
    img = img
      .resize(Math.max(1, target.w - 2 * m), Math.max(1, target.h - 2 * m), { fit: 'cover' })
      .extend({ top: m, bottom: m, left: m, right: m, background: '#ffffff' });
  } else {
    img = img.resize(target.w, target.h, { fit: 'cover' });
  }

  const out = await img.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, format: 'jpeg' };
}
