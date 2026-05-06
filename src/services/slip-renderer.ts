/**
 * Slip renderer service.
 *
 * Generates print-ready files for the three slip types:
 *
 *   1. order_info     — 4×6 dye-sub photo card with order details (top of customer's stack)
 *   2. end_separator  — 4×6 dye-sub photo card with brand moment "Hold the moment." (bottom of stack)
 *   3. envelope_label — 2-1/4×4 thermal label (Walmart-pattern, big LASTNAME, monospace)
 *
 * For dye-sub slips: render SVG → PNG (using sharp) → upload to B2 → return URL
 * For thermal label: generate ZPL command string → store in payload_json → no B2 upload needed
 */

import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

// Reuse the same B2 client config as image-storage.ts
const s3 = new S3Client({
  endpoint: `https://${env.B2_ENDPOINT}`,
  region: 'auto',
  credentials: {
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
  },
});

// ===== Brand constants (from locked Sunlit theme) =====

const BRAND = {
  cream: '#FBF7F0',
  ink: '#1F1B16',
  malachite: '#05D668',
  coral: '#FF7A59',
  fontSerif: 'Fraunces, Georgia, serif',
  fontSans: 'Outfit, system-ui, sans-serif',
  fontMono: 'DM Mono, Courier, monospace',
};

// 4×6 in at 300 DPI = 1200×1800 px
// 2.25×4 in at 203 DPI = 457×812 px (thermal printer DPI)
const DYE_SUB_4X6_PX = { width: 1200, height: 1800 };

// ===== Types =====

export interface OrderInfoSlipData {
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  fulfillmentMethod: 'collection' | 'delivery';
  items: Array<{
    quantity: number;
    sizeLabel: string; // e.g. "4×6 in"
  }>;
  orderedAt: Date;
}

export interface EnvelopeLabelData {
  orderNumber: string;
  customerName: string; // "Lastname;Firstname" format
  customerPhone: string;
  paymentMethod: string; // e.g. "EcoCash" or "Card"
  fulfillmentMethod: 'collection' | 'delivery';
  items: Array<{
    quantity: number;
    sizeLabel: string;
  }>;
  orderedAt: Date;
}

// ===== Renderers =====

/**
 * Render the order info slip (4×6 dye-sub) and upload to B2.
 * Returns the public URL of the rendered PNG.
 */
export async function renderOrderInfoSlip(
  data: OrderInfoSlipData,
): Promise<string> {
  const lastName = extractLastName(data.customerName);
  const orderedDate = formatDate(data.orderedAt);
  const itemLines = data.items
    .map((it) => `<tspan x="100" dy="60">${escapeXml(`${it.quantity} × ${it.sizeLabel}`)}</tspan>`)
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${DYE_SUB_4X6_PX.width}" height="${DYE_SUB_4X6_PX.height}" viewBox="0 0 ${DYE_SUB_4X6_PX.width} ${DYE_SUB_4X6_PX.height}">
  <rect width="100%" height="100%" fill="${BRAND.cream}"/>

  <!-- Header strip -->
  <rect x="0" y="0" width="${DYE_SUB_4X6_PX.width}" height="160" fill="${BRAND.ink}"/>
  <text x="100" y="105" font-family="${BRAND.fontSerif}" font-size="80" font-weight="700" fill="${BRAND.cream}">FusionPrints</text>

  <!-- Customer name -->
  <text x="100" y="280" font-family="${BRAND.fontSans}" font-size="36" font-weight="500" fill="${BRAND.ink}" opacity="0.6">For</text>
  <text x="100" y="370" font-family="${BRAND.fontSerif}" font-size="96" font-weight="700" fill="${BRAND.ink}">${escapeXml(lastName.toUpperCase())}</text>

  <!-- Order number -->
  <text x="100" y="480" font-family="${BRAND.fontSans}" font-size="36" font-weight="500" fill="${BRAND.ink}" opacity="0.6">Order</text>
  <text x="100" y="550" font-family="${BRAND.fontMono}" font-size="56" font-weight="500" fill="${BRAND.ink}">${escapeXml(data.orderNumber)}</text>

  <!-- Items section -->
  <line x1="100" y1="640" x2="${DYE_SUB_4X6_PX.width - 100}" y2="640" stroke="${BRAND.ink}" stroke-width="2" opacity="0.3"/>
  <text x="100" y="710" font-family="${BRAND.fontSans}" font-size="36" font-weight="500" fill="${BRAND.ink}" opacity="0.6">Inside</text>
  <text font-family="${BRAND.fontSans}" font-size="48" font-weight="500" fill="${BRAND.ink}">
    ${itemLines.replace(/dy="60"/, 'y="780"').replace(/dy="60"/g, 'dy="70"')}
  </text>

  <!-- Footer strip -->
  <rect x="0" y="${DYE_SUB_4X6_PX.height - 200}" width="${DYE_SUB_4X6_PX.width}" height="200" fill="${BRAND.ink}"/>
  <text x="100" y="${DYE_SUB_4X6_PX.height - 130}" font-family="${BRAND.fontSans}" font-size="32" font-weight="400" fill="${BRAND.cream}" opacity="0.7">${escapeXml(data.fulfillmentMethod === 'delivery' ? 'For delivery' : 'For pickup')}</text>
  <text x="100" y="${DYE_SUB_4X6_PX.height - 70}" font-family="${BRAND.fontMono}" font-size="36" font-weight="400" fill="${BRAND.cream}">${escapeXml(orderedDate)}</text>
  <text x="${DYE_SUB_4X6_PX.width - 100}" y="${DYE_SUB_4X6_PX.height - 70}" text-anchor="end" font-family="${BRAND.fontMono}" font-size="36" font-weight="400" fill="${BRAND.cream}">${escapeXml(data.customerPhone)}</text>
</svg>
`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const key = `slips/order-info/${data.orderNumber}-${randomUUID()}.png`;

  await s3.send(
    new PutObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key,
      Body: png,
      ContentType: 'image/png',
    }),
  );

  const url = `https://${env.B2_BUCKET_NAME}.${env.B2_ENDPOINT}/${key}`;
  logger.info({ orderNumber: data.orderNumber, key }, 'Rendered order info slip');
  return url;
}

/**
 * Render the end separator slip (4×6 dye-sub) — pure brand moment.
 * "Hold the moment." with the FusionPrints logo and tagline.
 * Same layout for every order (no per-order data needed).
 * Returns the public URL of the rendered PNG.
 */
export async function renderEndSeparatorSlip(orderNumber: string): Promise<string> {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${DYE_SUB_4X6_PX.width}" height="${DYE_SUB_4X6_PX.height}" viewBox="0 0 ${DYE_SUB_4X6_PX.width} ${DYE_SUB_4X6_PX.height}">
  <rect width="100%" height="100%" fill="${BRAND.cream}"/>

  <!-- Decorative photo-corner mark (top-left) -->
  <path d="M 80 80 L 240 80 L 80 240 Z" fill="${BRAND.malachite}"/>

  <!-- Decorative photo-corner mark (bottom-right) -->
  <path d="M ${DYE_SUB_4X6_PX.width - 80} ${DYE_SUB_4X6_PX.height - 80} L ${DYE_SUB_4X6_PX.width - 240} ${DYE_SUB_4X6_PX.height - 80} L ${DYE_SUB_4X6_PX.width - 80} ${DYE_SUB_4X6_PX.height - 240} Z" fill="${BRAND.coral}"/>

  <!-- Tagline (centered, the brand moment) -->
  <text x="${DYE_SUB_4X6_PX.width / 2}" y="${DYE_SUB_4X6_PX.height / 2 - 80}" text-anchor="middle" font-family="${BRAND.fontSerif}" font-size="140" font-weight="700" fill="${BRAND.ink}" font-style="italic">Hold</text>
  <text x="${DYE_SUB_4X6_PX.width / 2}" y="${DYE_SUB_4X6_PX.height / 2 + 60}" text-anchor="middle" font-family="${BRAND.fontSerif}" font-size="140" font-weight="700" fill="${BRAND.ink}" font-style="italic">the moment.</text>

  <!-- Brand line -->
  <text x="${DYE_SUB_4X6_PX.width / 2}" y="${DYE_SUB_4X6_PX.height / 2 + 200}" text-anchor="middle" font-family="${BRAND.fontSans}" font-size="40" font-weight="500" fill="${BRAND.ink}" opacity="0.7">— FusionPrints</text>

  <!-- Thank-you and find-us at bottom -->
  <text x="${DYE_SUB_4X6_PX.width / 2}" y="${DYE_SUB_4X6_PX.height - 280}" text-anchor="middle" font-family="${BRAND.fontSans}" font-size="36" font-weight="400" fill="${BRAND.ink}" opacity="0.7">Thank you for trusting us</text>
  <text x="${DYE_SUB_4X6_PX.width / 2}" y="${DYE_SUB_4X6_PX.height - 230}" text-anchor="middle" font-family="${BRAND.fontSans}" font-size="36" font-weight="400" fill="${BRAND.ink}" opacity="0.7">with your memories.</text>

  <text x="${DYE_SUB_4X6_PX.width / 2}" y="${DYE_SUB_4X6_PX.height - 130}" text-anchor="middle" font-family="${BRAND.fontMono}" font-size="32" font-weight="500" fill="${BRAND.ink}">@fusionprints  ·  fusionprints.co.zw</text>
</svg>
`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const key = `slips/end-separator/${orderNumber}-${randomUUID()}.png`;

  await s3.send(
    new PutObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key,
      Body: png,
      ContentType: 'image/png',
    }),
  );

  const url = `https://${env.B2_BUCKET_NAME}.${env.B2_ENDPOINT}/${key}`;
  logger.info({ orderNumber, key }, 'Rendered end separator slip');
  return url;
}

/**
 * Generate ZPL (Zebra Programming Language) for the envelope label.
 * Returns a ZPL command string — no image rendering, no B2 upload.
 * Stored in slip_jobs.payload_json for the agent to send directly to the thermal printer.
 *
 * Layout follows Walmart Photo Centre pattern:
 *   - Big LASTNAME at top (sorting handle)
 *   - Customer full name
 *   - Order number, payment status, phone
 *   - Inverted "Order Information" header
 *   - Items list (max 10 lines)
 *   - Inverted "FusionPrints HRE" footer
 *   - Order timestamp
 */
export function generateEnvelopeLabelZpl(data: EnvelopeLabelData): string {
  const lastName = extractLastName(data.customerName).toUpperCase();
  const orderedDate = formatDate(data.orderedAt);

  // ZPL coordinate system: 8 dots per mm at 203 DPI.
  // Label is 2.25×4 in = 457×812 dots.
  // We work in dots throughout.

  const lines: string[] = [];
  lines.push('^XA');                  // Start label
  lines.push('^CI28');                // UTF-8
  lines.push('^PW457');               // Print width 2.25 in (457 dots)
  lines.push('^LL812');               // Label length 4 in (812 dots)
  lines.push('^LH0,0');               // Label home

  // Big LASTNAME (top)
  lines.push(`^FO20,30^A0N,80,60^FD${zplEscape(lastName)}^FS`);

  // Full customer name
  lines.push(`^FO20,120^A0N,30,18^FD${zplEscape(data.customerName)}^FS`);

  // Order number
  lines.push(`^FO20,160^A0N,28,16^FD${zplEscape(data.orderNumber)}^FS`);

  // Payment + fulfillment
  lines.push(`^FO20,195^A0N,28,16^FDPaid \u00B7 ${zplEscape(data.paymentMethod)}^FS`);

  // Phone
  lines.push(`^FO20,230^A0N,28,16^FD${zplEscape(data.customerPhone)}^FS`);

  // Inverted section header "Order Information" (white text on black background)
  lines.push('^FO20,280^GB417,38,38,B,0^FS');                          // Black bar
  lines.push(`^FO20,288^A0N,28,16^FR^FDOrder Information^FS`);          // Reverse text

  // Items list — Up to 10 lines fit in remaining space
  const itemList: string[] = [];
  itemList.push(data.fulfillmentMethod === 'delivery' ? 'Delivery' : 'Walk-in pickup');
  for (const item of data.items) {
    itemList.push(`${item.quantity} - ${item.sizeLabel}`);
  }
  let itemY = 340;
  for (const line of itemList.slice(0, 10)) {
    lines.push(`^FO20,${itemY}^A0N,28,16^FD${zplEscape(line)}^FS`);
    itemY += 32;
  }

  // Inverted footer "FusionPrints HRE"
  const footerY = 690;
  lines.push(`^FO20,${footerY}^GB417,38,38,B,0^FS`);
  lines.push(`^FO20,${footerY + 8}^A0N,28,16^FR^FDFusionPrints HRE^FS`);

  // Timestamp at very bottom
  lines.push(`^FO20,750^A0N,24,14^FDOrdered: ${zplEscape(orderedDate)}^FS`);

  lines.push('^XZ');                  // End label

  return lines.join('\n');
}

// ===== Helpers =====

function extractLastName(fullName: string): string {
  // Names come in as "Firstname Lastname" or "Lastname;Firstname" or just "Firstname"
  if (fullName.includes(';')) {
    return fullName.split(';')[0].trim();
  }
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0];
}

function formatDate(d: Date): string {
  // "02 May 2026 14:32"
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} ${hour}:${min}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function zplEscape(s: string): string {
  // ZPL doesn't have escape sequences — the special chars are ^ and ~ (which we strip)
  // Also avoid line breaks in field data
  return s.replace(/[\^~]/g, '').replace(/[\r\n]/g, ' ');
}
