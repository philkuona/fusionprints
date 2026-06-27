/**
 * Outsource print-ready package (Outsource Routing — Phase 3).
 *
 * Turns the outsourced line items of a paid order into a "stupid-simple" bundle a
 * partner print shop can drop straight into their workflow: each image rendered
 * print-ready (correct size, crop baked in, **sRGB embedded**, JPEG q95 4:4:4) +
 * a human-readable spec PDF + a machine-readable spec JSON, zipped.
 *
 * The partner never sees customer name, phone, or our retail price — the spec
 * type below simply has no field for them, so the JSON cannot leak.
 *
 * Phase 3 builds the package; Phase 4 dispatches it (email). The pure helpers
 * (filename / spec / zip) are unit-tested; the DB + render functions are not.
 */
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, images, processedImages, type OutsourcePartner } from '@/db/schema.js';
import { getProduct } from '@/config/catalog.js';
import { getImageBuffer } from '@/services/image-storage.js';
import { getDefaultPartner } from '@/services/outsource-partners.js';
import { logger } from '@/utils/logger.js';

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

function slug(s: string): string {
  return String(s ?? '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Print-ready filename — survives email + WhatsApp transfers unambiguously:
 * `{orderRef}_{lineItem}_{size}_{finish}_x{qty}.jpg`. The line-item fragment is a
 * short slice of the item id so multiple lines of the same size stay distinct.
 */
export function printReadyFilename(
  orderRef: string,
  item: { id: string; sizeCode: string; finish: string; quantity: number },
): string {
  const short = item.id.replace(/-/g, '').slice(0, 8);
  return `${slug(orderRef)}_${short}_${slug(item.sizeCode)}_${slug(item.finish)}_x${item.quantity}.jpg`;
}

export interface SpecLineItem {
  lineItemId: string;
  fileName: string;
  sizeCode: string;
  sizeLabel: string;
  finish: string;
  quantity: number;
  border: boolean;
  /** Plain-language production notes (no PII). */
  instructions: string[];
}

export interface OutsourceSpec {
  schemaVersion: 'fusionprints.outsource.v1';
  orderRef: string;
  itemCount: number;
  items: SpecLineItem[];
  /** Generic production/handover note — never customer-identifying. */
  note: string;
}

/** Per-item instruction lines, derived from the item (no customer data). */
export function itemInstructions(item: { border: boolean }): string[] {
  return [
    'Print as supplied — cropping and sizing are already baked in. Do not crop or resize.',
    item.border ? 'White border is part of the file — print full-bleed (do not add a border).' : 'Full-bleed, no border.',
    'Colour profile: sRGB (embedded).',
  ];
}

/** Build the spec object. Pure — structurally cannot carry customer PII or price. */
export function buildSpec(input: { orderRef: string; items: SpecLineItem[] }): OutsourceSpec {
  return {
    schemaVersion: 'fusionprints.outsource.v1',
    orderRef: input.orderRef,
    itemCount: input.items.reduce((n, i) => n + i.quantity, 0),
    items: input.items,
    note: 'Produced for FusionPrints. Hold for collection — we arrange pickup separately. Quote the order reference on any query.',
  };
}

/** Zip a set of in-memory files into a single Buffer. Pure (no DB). */
export async function zipFiles(files: { name: string; buffer: Buffer }[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.buffer);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ── Spec PDF (SVG → PNG → pdf-lib, mirroring receipt-pdf.ts) ───────────────────

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Human-readable spec sheet SVG. Pure. Carries order ref + per-item specs only. */
export function buildSpecSvg(spec: OutsourceSpec): string {
  const W = 1240; // ~A4 portrait at ~150 DPI
  const H = 1754;
  let y = 150;
  const rows: string[] = [];
  spec.items.forEach((it, i) => {
    rows.push(`<text x="90" y="${y}" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#1F1B16">${i + 1}. ${esc(it.sizeLabel)} — ×${it.quantity}</text>`);
    y += 40;
    rows.push(`<text x="110" y="${y}" font-family="Arial, sans-serif" font-size="24" fill="#444">File: ${esc(it.fileName)}</text>`);
    y += 34;
    rows.push(`<text x="110" y="${y}" font-family="Arial, sans-serif" font-size="24" fill="#444">Finish: ${esc(it.finish)}</text>`);
    y += 34;
    for (const line of it.instructions) {
      rows.push(`<text x="110" y="${y}" font-family="Arial, sans-serif" font-size="22" fill="#666">• ${esc(line)}</text>`);
      y += 30;
    }
    y += 26;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <text x="90" y="80" font-family="Arial, sans-serif" font-size="44" font-weight="800" fill="#05D668">FusionPrints — Print Order</text>
    <text x="90" y="120" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#1F1B16">Ref: ${esc(spec.orderRef)} · ${spec.itemCount} print(s)</text>
    ${rows.join('\n    ')}
    <text x="90" y="${H - 80}" font-family="Arial, sans-serif" font-size="22" fill="#666">${esc(spec.note)}</text>
  </svg>`;
}

async function renderSpecPdf(spec: OutsourceSpec): Promise<Buffer | null> {
  try {
    const png = await sharp(Buffer.from(buildSpecSvg(spec))).png().toBuffer();
    const pdf = await PDFDocument.create();
    const img = await pdf.embedPng(png);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return Buffer.from(await pdf.save());
  } catch (err) {
    logger.error({ orderRef: spec.orderRef, err }, 'Failed to render outsource spec PDF');
    return null;
  }
}

// ── Print-ready image rendering ────────────────────────────────────────────────

/**
 * Render one outsource line item to a print-ready JPEG with an embedded sRGB
 * profile. Web items already have a processed render at the correct size + edits
 * (re-emit with sRGB); raw (WhatsApp) items are cover-fit to the size's target
 * resolution oriented to the source aspect.
 */
async function renderPrintReady(item: {
  sizeCode: string;
  imageId: string | null;
  processedImageId: string | null;
}): Promise<{ buffer: Buffer; width: number; height: number; border: boolean }> {
  const product = getProduct(item.sizeCode);
  if (!product) throw new Error(`Unknown size ${item.sizeCode}`);

  if (item.processedImageId) {
    const [p] = await db.select().from(processedImages).where(eq(processedImages.id, item.processedImageId)).limit(1);
    if (!p) throw new Error(`Processed image ${item.processedImageId} not found`);
    const src = await getImageBuffer(p.processedStorageKey);
    const out = await sharp(src)
      .withIccProfile('srgb')
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });
    const border = !!(p.editPayload as { border?: boolean } | null)?.border;
    return { buffer: out.data, width: out.info.width, height: out.info.height, border };
  }

  if (!item.imageId) throw new Error('Line item has neither a processed nor a source image');
  const [img] = await db.select().from(images).where(eq(images.id, item.imageId)).limit(1);
  if (!img) throw new Error(`Source image ${item.imageId} not found`);
  const src = await getImageBuffer(img.storageKey);
  const meta = await sharp(src).metadata();
  const rec = product.recommendedResolution;
  const long = Math.max(rec.width, rec.height);
  const shortSide = Math.min(rec.width, rec.height);
  const srcLandscape = (meta.width ?? 0) >= (meta.height ?? 0);
  const target = srcLandscape ? { w: long, h: shortSide } : { w: shortSide, h: long };
  const out = await sharp(src)
    .rotate() // bake EXIF orientation
    .resize(target.w, target.h, { fit: 'cover' })
    .withIccProfile('srgb')
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, border: false };
}

// ── Package assembly ───────────────────────────────────────────────────────────

export interface OutsourcePackage {
  orderId: string;
  orderNumber: string;
  partner: OutsourcePartner | null;
  files: { name: string; buffer: Buffer }[];
  spec: OutsourceSpec;
  zip: Buffer;
}

/**
 * Build the print-ready package for an order's outsourced items, or null if the
 * order has none (or doesn't exist). The active default partner is attached for
 * the dispatcher's convenience but is NOT required to build the package.
 */
export async function buildOutsourcePackage(orderId: string): Promise<OutsourcePackage | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return null;

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const outsourceItems = items.filter((i) => getProduct(i.sizeCode)?.fulfillment === 'outsource');
  if (outsourceItems.length === 0) return null;

  const partner = await getDefaultPartner();

  const files: { name: string; buffer: Buffer }[] = [];
  const specItems: SpecLineItem[] = [];
  for (const item of outsourceItems) {
    const product = getProduct(item.sizeCode)!;
    const rendered = await renderPrintReady(item);
    const fileName = printReadyFilename(order.orderNumber, {
      id: item.id,
      sizeCode: item.sizeCode,
      finish: product.finish,
      quantity: item.quantity,
    });
    files.push({ name: fileName, buffer: rendered.buffer });
    specItems.push({
      lineItemId: item.id,
      fileName,
      sizeCode: item.sizeCode,
      sizeLabel: product.displayLabel,
      finish: product.finish,
      quantity: item.quantity,
      border: rendered.border,
      instructions: itemInstructions({ border: rendered.border }),
    });
  }

  const spec = buildSpec({ orderRef: order.orderNumber, items: specItems });
  files.push({ name: `${slug(order.orderNumber)}_spec.json`, buffer: Buffer.from(JSON.stringify(spec, null, 2)) });
  const specPdf = await renderSpecPdf(spec);
  if (specPdf) files.push({ name: `${slug(order.orderNumber)}_spec.pdf`, buffer: specPdf });

  const zip = await zipFiles(files);
  logger.info({ orderId, orderNumber: order.orderNumber, items: outsourceItems.length, files: files.length }, 'Built outsource package');
  return { orderId, orderNumber: order.orderNumber, partner, files, spec, zip };
}
