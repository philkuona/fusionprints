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
import { registerBrandFonts } from '@/utils/fonts.js';

// Ensure Sharp/librsvg can see the bundled brand fonts before any slip renders.
registerBrandFonts();

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

// Sunlit-theme palette + brand fonts. Mirrors the COLORS map in the approved
// slip mockup (docs/slip-templates) exactly so the rendered cards match it.
// Serif resolves to the real bundled Fraunces (Georgia only as a safety net).
const BRAND = {
  cream: '#FBF7F0', // bg
  bgWarm: '#F4ECDD', // warm panel fill (items box)
  ink: '#1F1B16',
  inkSoft: '#4A3F32',
  inkMute: '#8A7B66',
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
  paymentMethod: string; // e.g. "EcoCash" or "Card" — shown as a status pill
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

// ===== SVG builders (pure — no I/O, so they can be previewed offline) =====

/**
 * Build the order-info card SVG (4×6, 300 DPI) — a faithful port of the approved
 * CSS mockup (docs/slip-templates "slips-preview", slip 1) scaled ×3 to print
 * resolution. Compact logo lockup + date, order number, name + phone, an items
 * panel, Paid/method pills, and a small centered "— ORDER START —" line.
 */
export function buildOrderInfoSvg(data: OrderInfoSlipData): string {
  registerBrandFonts();
  const W = DYE_SUB_4X6_PX.width;
  const H = DYE_SUB_4X6_PX.height;
  const PAD = 72; // 24px × 3
  const RIGHT = W - PAD;
  const { dateStr, timeStr } = formatDateParts(data.orderedAt);

  // Items inside the warm panel. Row = label (Fraunces) left + ×qty (mono) right.
  const visibleItems = data.items.slice(0, 4);
  const remainingItems = data.items.length - visibleItems.length;
  const boxTop = 560;
  const boxPadX = 48; // 16px × 3
  const itemX = PAD + boxPadX; // 120
  const titleY = boxTop + 66;
  const firstItemY = boxTop + 150;
  const rowStep = 62;
  const itemRows = visibleItems
    .map((item, i) => {
      const y = firstItemY + i * rowStep;
      return `
  <text x="${itemX}" y="${y}" font-family="${BRAND.fontSerif}" font-size="39" font-weight="500" fill="${BRAND.ink}">${escapeXml(item.sizeLabel)}</text>
  <text x="${RIGHT - boxPadX}" y="${y}" font-family="${BRAND.fontMono}" font-size="36" fill="${BRAND.inkSoft}" text-anchor="end">×${item.quantity}</text>`;
    })
    .join('');
  const remainingNote =
    remainingItems > 0
      ? `<text x="${itemX}" y="${firstItemY + visibleItems.length * rowStep}" font-family="${BRAND.fontMono}" font-size="30" fill="${BRAND.inkMute}">+ ${remainingItems} more item${remainingItems === 1 ? '' : 's'}</text>`
      : '';
  const rowCount = visibleItems.length + (remainingItems > 0 ? 1 : 0);
  const boxH = data.items.length > 0 ? firstItemY + (rowCount - 1) * rowStep + 54 - boxTop : 150;

  // Keep a long name (or an email used as a name) inside the card.
  const name = fitText(data.customerName, 54, 34, W - PAD * 2, 0.55);

  // Paid + payment-method pills, bottom-left.
  const pillY = 1604;
  const pillH = 60;
  const paidW = 188;
  const gap = 24;
  const methodX = PAD + paidW + gap;
  const methodW = Math.max(170, data.paymentMethod.length * 26 + 64);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BRAND.cream}"/>

  <!-- Header: compact logo lockup + date -->
  <g transform="translate(${PAD}, 72) scale(1.0714)">
    <g transform="translate(0,6)">
      <path d="M0 8 L12 0 L40 0 L40 14 L26 14 L14 22 L14 48 L0 48 Z" fill="${BRAND.ink}"/>
      <path d="M14 22 L26 14 L40 14 L40 28 Z" fill="${BRAND.malachite}"/>
    </g>
    <text x="56" y="40" font-family="${BRAND.fontSans}" font-size="28" font-weight="700" fill="${BRAND.ink}" letter-spacing="-0.56">fusionprints</text>
  </g>
  <text x="${RIGHT}" y="120" font-family="${BRAND.fontMono}" font-size="33" fill="${BRAND.inkMute}" text-anchor="end" letter-spacing="1.2">${escapeXml(dateStr)} · ${escapeXml(timeStr)}</text>
  <rect x="${PAD}" y="186" width="${W - PAD * 2}" height="2" fill="${BRAND.ink}" fill-opacity="0.10"/>

  <!-- Order, customer -->
  <text x="${PAD}" y="270" font-family="${BRAND.fontMono}" font-size="27" fill="${BRAND.inkMute}" letter-spacing="3.2">ORDER</text>
  <text x="${PAD}" y="345" font-family="${BRAND.fontSerif}" font-size="66" font-weight="500" fill="${BRAND.ink}">${escapeXml(data.orderNumber)}</text>
  <text x="${PAD}" y="438" font-family="${BRAND.fontSans}" font-size="${name.fontSize}" font-weight="600" fill="${BRAND.ink}">${escapeXml(name.text)}</text>
  <text x="${PAD}" y="494" font-family="${BRAND.fontMono}" font-size="39" fill="${BRAND.inkSoft}">${escapeXml(data.customerPhone)}</text>

  <!-- Items panel -->
  <rect x="${PAD}" y="${boxTop}" width="${W - PAD * 2}" height="${boxH}" rx="24" fill="${BRAND.bgWarm}"/>
  <text x="${itemX}" y="${titleY}" font-family="${BRAND.fontMono}" font-size="27" fill="${BRAND.inkMute}" letter-spacing="3.2">ITEMS</text>${itemRows}
  ${remainingNote}

  <!-- Status pills -->
  <rect x="${PAD}" y="${pillY}" width="${paidW}" height="${pillH}" rx="${pillH / 2}" fill="${BRAND.malachite}"/>
  <text x="${PAD + paidW / 2}" y="${pillY + 40}" font-family="${BRAND.fontMono}" font-size="28" font-weight="500" fill="${BRAND.ink}" text-anchor="middle" letter-spacing="2.0">✓ PAID</text>
  <rect x="${methodX}" y="${pillY}" width="${methodW}" height="${pillH}" rx="${pillH / 2}" fill="${BRAND.ink}"/>
  <text x="${methodX + methodW / 2}" y="${pillY + 40}" font-family="${BRAND.fontMono}" font-size="26" font-weight="500" fill="${BRAND.cream}" text-anchor="middle" letter-spacing="1.8">${escapeXml(data.paymentMethod.toUpperCase())}</text>

  <!-- Footer -->
  <text x="${W / 2}" y="1720" font-family="${BRAND.fontMono}" font-size="27" fill="${BRAND.inkMute}" text-anchor="middle" letter-spacing="2.7">— ORDER START —</text>
</svg>
`;
}

// ===== Renderers =====

/**
 * Render the order info slip (4×6 dye-sub) and upload to B2.
 * Returns the public URL of the rendered PNG.
 */
export async function renderOrderInfoSlip(
  data: OrderInfoSlipData,
): Promise<string> {
  const png = await sharp(Buffer.from(buildOrderInfoSvg(data))).png().toBuffer();
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
 * Build the end-separator card SVG (4×6, 300 DPI) — a faithful port of the
 * approved CSS mockup (docs/slip-templates "slips-preview", slip 4) scaled ×3.
 * Lands at the bottom of the stack: thin ink corner crop-marks, centered logo
 * mark, "Hold the moment.", the customer's first name, and the WhatsApp help
 * line. The "WhatsApp us" number is the business WhatsApp line (single source of
 * truth: env.BUSINESS_PHONE — the same value the upload page uses).
 */
export function buildEndSeparatorSvg(data: { orderNumber: string; customerFirstName: string }): string {
  registerBrandFonts();
  const W = DYE_SUB_4X6_PX.width;
  const H = DYE_SUB_4X6_PX.height;
  const cx = W / 2;
  const whatsappNumber = env.BUSINESS_PHONE?.trim() ?? '';
  // Centered first name — shrink/clip so an unusually long one stays on the card.
  const firstName = fitText(data.customerFirstName, 66, 44, W - 144, 0.52);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BRAND.cream}"/>

  <!-- Corner crop-marks (top-left + bottom-right L brackets) -->
  <g stroke="${BRAND.ink}" stroke-width="6" fill="none" stroke-linecap="square">
    <path d="M 48 48 L 48 144" />
    <path d="M 48 48 L 144 48" />
    <path d="M ${W - 48} ${H - 48} L ${W - 48} ${H - 144}" />
    <path d="M ${W - 48} ${H - 48} L ${W - 144} ${H - 48}" />
  </g>

  <!-- Centered logo mark -->
  <g transform="translate(${cx - 68}, 415) scale(3.4)">
    <path d="M0 8 L12 0 L40 0 L40 14 L26 14 L14 22 L14 48 L0 48 Z" fill="${BRAND.ink}"/>
    <path d="M14 22 L26 14 L40 14 L40 28 Z" fill="${BRAND.malachite}"/>
  </g>

  <!-- The brand moment -->
  <text x="${cx}" y="735" font-family="${BRAND.fontSerif}" font-size="114" font-weight="500" font-style="italic" fill="${BRAND.ink}" text-anchor="middle" letter-spacing="-2.3">Hold</text>
  <text x="${cx}" y="860" font-family="${BRAND.fontSerif}" font-size="114" font-weight="500" font-style="italic" fill="${BRAND.ink}" text-anchor="middle" letter-spacing="-2.3">the moment.</text>
  <rect x="${cx - 48}" y="958" width="96" height="3" fill="${BRAND.ink}" opacity="0.30"/>

  <!-- Thank-you + customer first name -->
  <text x="${cx}" y="1098" font-family="${BRAND.fontSans}" font-size="48" font-weight="500" fill="${BRAND.ink}" text-anchor="middle">Thank you,</text>
  <text x="${cx}" y="1190" font-family="${BRAND.fontSerif}" font-size="${firstName.fontSize}" font-weight="500" font-style="italic" fill="${BRAND.coral}" text-anchor="middle">${escapeXml(firstName.text)}</text>

  <!-- Help line -->
  <text x="${cx}" y="1318" font-family="${BRAND.fontSans}" font-size="36" fill="${BRAND.inkSoft}" text-anchor="middle">Any issues? <tspan font-weight="600" fill="${BRAND.ink}">WhatsApp us</tspan></text>
  <text x="${cx}" y="1374" font-family="${BRAND.fontSans}" font-size="36" fill="${BRAND.inkSoft}" text-anchor="middle">${escapeXml(whatsappNumber)}</text>

  <!-- Footer meta -->
  <text x="${cx}" y="${H - 84}" font-family="${BRAND.fontMono}" font-size="27" fill="${BRAND.inkMute}" text-anchor="middle" letter-spacing="2.7">— ${escapeXml(data.orderNumber)} · END —</text>
</svg>
`;
}

/**
 * Render the end separator slip (4×6 dye-sub) — the brand moment that lands at
 * the bottom of the stack. Returns the public URL of the rendered PNG.
 */
export async function renderEndSeparatorSlip(orderNumber: string, customerFirstName: string): Promise<string> {
  const png = await sharp(Buffer.from(buildEndSeparatorSvg({ orderNumber, customerFirstName }))).png().toBuffer();
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
 *   - Inverted business-name footer
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

  // Printable width is 417 dots (457 minus the 20-dot margins). Long names
  // (or emails used as names) must shrink to fit, then truncate as a last resort.
  const LABEL_TEXT_DOTS = 417;

  // Big LASTNAME (top)
  const bigName = fitZplText(lastName, {
    baseWidth: 60,
    baseHeight: 80,
    minWidth: 26,
    maxDots: LABEL_TEXT_DOTS,
  });
  lines.push(`^FO20,30^A0N,${bigName.height},${bigName.width}^FD${zplEscape(bigName.text)}^FS`);

  // Full customer name
  const fullName = fitZplText(data.customerName, {
    baseWidth: 18,
    baseHeight: 30,
    minWidth: 12,
    maxDots: LABEL_TEXT_DOTS,
  });
  lines.push(`^FO20,120^A0N,${fullName.height},${fullName.width}^FD${zplEscape(fullName.text)}^FS`);

  // Order number
  lines.push(`^FO20,160^A0N,28,16^FD${zplEscape(data.orderNumber)}^FS`);

  // Payment + fulfillment
  lines.push(`^FO20,195^A0N,28,16^FDPaid \u00B7 ${zplEscape(data.paymentMethod)}^FS`);

  // Phone
  lines.push(`^FO20,230^A0N,28,16^FD${zplEscape(data.customerPhone)}^FS`);

  // Inverted section header "Order Information" (white text on black background)
  lines.push('^FO20,280^GB417,38,38,B,0^FS');                          // Black bar
  lines.push(`^FO20,288^A0N,28,16^FR^FDOrder Information^FS`);          // Reverse text

  // Items list — Up to 10 lines fit in remaining space; summarise overflow
  const itemList: string[] = [];
  itemList.push(data.fulfillmentMethod === 'delivery' ? 'Delivery' : 'Walk-in pickup');
  for (const item of data.items) {
    itemList.push(`${item.quantity} - ${item.sizeLabel}`);
  }
  const MAX_LABEL_LINES = 10;
  const visibleLines = itemList.slice(0, MAX_LABEL_LINES);
  if (itemList.length > MAX_LABEL_LINES) {
    visibleLines[MAX_LABEL_LINES - 1] = `+ ${itemList.length - MAX_LABEL_LINES + 1} more`;
  }
  let itemY = 340;
  for (const line of visibleLines) {
    lines.push(`^FO20,${itemY}^A0N,28,16^FD${zplEscape(line)}^FS`);
    itemY += 32;
  }

  // Inverted footer with the business name
  const footerY = 690;
  lines.push(`^FO20,${footerY}^GB417,38,38,B,0^FS`);
  lines.push(`^FO20,${footerY + 8}^A0N,28,16^FR^FD${env.BUSINESS_NAME}^FS`);

  // Timestamp at very bottom
  lines.push(`^FO20,750^A0N,24,14^FDOrdered: ${zplEscape(orderedDate)}^FS`);

  lines.push('^XZ');                  // End label

  return lines.join('\n');
}

// ===== Helpers =====

/**
 * Fit a single line of ZPL ^A0 text into maxDots: shrink the char width
 * (keeping the base aspect ratio) down to minWidth, then truncate if needed.
 * ^A0 is proportional, so char-count × width is a conservative estimate.
 */
function fitZplText(
  text: string,
  opts: { baseWidth: number; baseHeight: number; minWidth: number; maxDots: number },
): { text: string; width: number; height: number } {
  let width = opts.baseWidth;
  if (text.length * width > opts.maxDots) {
    width = Math.max(opts.minWidth, Math.floor(opts.maxDots / text.length));
  }

  if (text.length * width > opts.maxDots) {
    text = text.slice(0, Math.max(1, Math.floor(opts.maxDots / width) - 1));
  }

  const height = Math.round(width * (opts.baseHeight / opts.baseWidth));
  return { text, width, height };
}

function extractLastName(fullName: string): string {
  // Names come in as "Firstname Lastname" or "Lastname;Firstname" or just "Firstname"
  if (fullName.includes(';')) {
    return fullName.split(';')[0].trim();
  }
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0];
}

/** First name for the separator's "Thank you, {name}". Handles "Last;First" too. */
export function extractFirstName(fullName: string): string {
  const name = fullName.trim();
  if (!name) return 'Friend';
  if (name.includes(';')) {
    // "Lastname;Firstname"
    return name.split(';')[1]?.trim() || name.split(';')[0].trim() || 'Friend';
  }
  // If the "name" is actually an email (no display name set), use the local part.
  const first = name.split(/\s+/)[0];
  return first.includes('@') ? first.split('@')[0] : first;
}

/**
 * Pick a font size that keeps `text` within `maxWidth`, shrinking from `baseSize`
 * down to `minSize`, and (only if still too wide at minSize) truncate with an
 * ellipsis. Keeps long names/emails from ever running off the card so every
 * order's card lays out identically. `emRatio` ≈ average glyph width per em.
 */
function fitText(
  text: string,
  baseSize: number,
  minSize: number,
  maxWidth: number,
  emRatio: number,
): { text: string; fontSize: number } {
  if (!text) return { text, fontSize: baseSize };
  if (text.length * baseSize * emRatio <= maxWidth) return { text, fontSize: baseSize };
  const fontSize = Math.max(minSize, Math.floor(maxWidth / (text.length * emRatio)));
  const maxChars = Math.floor(maxWidth / (fontSize * emRatio));
  const out = text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
  return { text: out, fontSize };
}

/** Split a date into the card's "02 May 2026" + "14:32" parts. */
function formatDateParts(d: Date): { dateStr: string; timeStr: string } {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return { dateStr: `${day} ${month} ${year}`, timeStr: `${hour}:${min}` };
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
