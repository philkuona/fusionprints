/**
 * In-chat WhatsApp receipt (PR-7b).
 *
 * Renders a branded one-page PDF receipt for a paid order and sends it into the
 * customer's WhatsApp chat as a document. The PDF is a single PNG (rendered from
 * an SVG with sharp, same pipeline as the print slips) embedded via pdf-lib —
 * no headless browser. Best-effort: failures are logged, never thrown, so a
 * receipt problem can't affect a paid order.
 */
import sharp from 'sharp';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, customers } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { registerBrandFonts } from '@/utils/fonts.js';
import { getProduct } from '@/config/catalog.js';
import { getOrderCollectionPoint } from '@/services/collection-points.js';
import { sendWhatsAppDocument } from '@/services/whatsapp.js';
import { isEnabled as qboEnabled, isSetupComplete as qboSetupComplete, fetchTxnPdf } from '@/services/qbo.js';

registerBrandFonts();

const s3 = new S3Client({
  endpoint: `https://${env.B2_ENDPOINT}`,
  region: 'auto',
  credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APPLICATION_KEY },
});

const C = {
  cream: '#FBF7F0',
  panel: '#FFFFFF',
  ink: '#1F1B16',
  inkSoft: '#4A3F32',
  inkMute: '#8A7B66',
  malachite: '#05D668',
  line: '#E7DED0',
  serif: 'Fraunces, Georgia, serif',
  sans: 'Outfit, system-ui, sans-serif',
  mono: 'DM Mono, Courier, monospace',
};

function money(v: string | number): string {
  return `$${Number(v).toFixed(2)}`;
}
function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface ReceiptLine {
  label: string;
  qty: number;
  lineTotal: string;
}

export function buildReceiptSvg(d: {
  orderNumber: string;
  dateStr: string;
  customerName: string;
  lines: ReceiptLine[];
  subtotal: string;
  delivery: string;
  total: string;
  fulfilment: string;
}): string {
  const W = 820;
  const pad = 48;
  const rowH = 46;
  const headerH = 210;
  const itemsTop = headerH + 56;
  const itemsH = d.lines.length * rowH + 16;
  const totalsTop = itemsTop + itemsH + 24;
  const totalsH = 132;
  const fulfilTop = totalsTop + totalsH + 24;
  const H = fulfilTop + 150;

  const itemRows = d.lines
    .map((l, i) => {
      const y = itemsTop + 30 + i * rowH;
      return `
        <text x="${pad}" y="${y}" font-family="${C.sans}" font-size="20" fill="${C.ink}">${esc(l.qty + ' × ' + l.label)}</text>
        <text x="${W - pad}" y="${y}" font-family="${C.mono}" font-size="20" fill="${C.ink}" text-anchor="end">${l.lineTotal}</text>
        <line x1="${pad}" y1="${y + 16}" x2="${W - pad}" y2="${y + 16}" stroke="${C.line}" stroke-width="1"/>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${C.cream}"/>
    <!-- header -->
    <g transform="translate(${pad},56)">
      <path d="M0 8 L12 0 L40 0 L40 14 L26 14 L14 22 L14 48 L0 48 Z" fill="${C.ink}"/>
      <path d="M14 22 L26 14 L40 14 L40 28 Z" fill="${C.malachite}"/>
      <text x="52" y="38" font-family="${C.sans}" font-size="30" font-weight="700" fill="${C.ink}" letter-spacing="-0.5">fusionprints</text>
    </g>
    <text x="${pad}" y="150" font-family="${C.serif}" font-size="30" font-weight="600" fill="${C.ink}">Receipt</text>
    <text x="${W - pad}" y="132" font-family="${C.mono}" font-size="20" fill="${C.inkMute}" text-anchor="end">${esc(d.orderNumber)}</text>
    <text x="${W - pad}" y="158" font-family="${C.sans}" font-size="16" fill="${C.inkMute}" text-anchor="end">${esc(d.dateStr)}</text>
    <text x="${pad}" y="184" font-family="${C.sans}" font-size="18" fill="${C.inkSoft}">For ${esc(d.customerName)}</text>
    <line x1="${pad}" y1="${headerH}" x2="${W - pad}" y2="${headerH}" stroke="${C.line}" stroke-width="1.5"/>

    <!-- items -->
    <text x="${pad}" y="${itemsTop}" font-family="${C.sans}" font-size="13" letter-spacing="1.5" fill="${C.inkMute}">ITEMS</text>
    ${itemRows}

    <!-- totals -->
    <text x="${pad}" y="${totalsTop + 24}" font-family="${C.sans}" font-size="18" fill="${C.inkSoft}">Subtotal</text>
    <text x="${W - pad}" y="${totalsTop + 24}" font-family="${C.mono}" font-size="18" fill="${C.ink}" text-anchor="end">${d.subtotal}</text>
    <text x="${pad}" y="${totalsTop + 54}" font-family="${C.sans}" font-size="18" fill="${C.inkSoft}">Delivery</text>
    <text x="${W - pad}" y="${totalsTop + 54}" font-family="${C.mono}" font-size="18" fill="${C.ink}" text-anchor="end">${d.delivery}</text>
    <line x1="${pad}" y1="${totalsTop + 74}" x2="${W - pad}" y2="${totalsTop + 74}" stroke="${C.line}" stroke-width="1.5"/>
    <text x="${pad}" y="${totalsTop + 108}" font-family="${C.serif}" font-size="24" font-weight="600" fill="${C.ink}">Total paid</text>
    <text x="${W - pad}" y="${totalsTop + 108}" font-family="${C.mono}" font-size="24" font-weight="600" fill="${C.ink}" text-anchor="end">${d.total}</text>

    <!-- fulfilment -->
    <rect x="${pad}" y="${fulfilTop}" width="${W - pad * 2}" height="86" rx="14" fill="${C.panel}" stroke="${C.line}"/>
    <text x="${pad + 22}" y="${fulfilTop + 36}" font-family="${C.sans}" font-size="18" font-weight="600" fill="${C.ink}">${esc(d.fulfilment.split('\n')[0] ?? '')}</text>
    <text x="${pad + 22}" y="${fulfilTop + 62}" font-family="${C.sans}" font-size="15" fill="${C.inkSoft}">${esc(d.fulfilment.split('\n')[1] ?? '')}</text>
    <text x="${pad}" y="${H - 28}" font-family="${C.sans}" font-size="14" fill="${C.inkMute}">FusionPrints. Hold the moment.</text>
  </svg>`;
}

/** The QBO-rendered invoice PDF for an order, if available. This is the preferred
 * receipt: branded via the company's QBO Custom Form Style and showing the
 * payment + PAID status. Null when QBO is off, the order has no invoice, or the
 * fetch fails — callers then fall back to the local SVG renderer. The QBO payment
 * is recorded before receipts are sent (markOrderPaid awaits it), so by the time
 * this runs the invoice already reads PAID. */
async function renderQboReceiptPdf(orderNumber: string): Promise<Buffer | null> {
  if (!qboEnabled() || !qboSetupComplete()) return null;
  const [order] = await db
    .select({ qboInvoiceId: orders.qboInvoiceId })
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);
  if (!order?.qboInvoiceId) return null;
  const pdf = await fetchTxnPdf('invoice', order.qboInvoiceId);
  if (pdf) logger.info({ orderNumber }, 'Receipt PDF: using QBO-rendered invoice');
  return pdf;
}

/** Render the branded receipt PDF for an order → bytes. Null on error. Shared by
 * the email attachment and the WhatsApp document. Prefers the QBO-rendered
 * invoice PDF; falls back to the local SVG receipt when QBO is unavailable. */
export async function renderReceiptPdfBytes(orderNumber: string): Promise<Buffer | null> {
  const qboPdf = await renderQboReceiptPdf(orderNumber).catch(() => null);
  if (qboPdf) return qboPdf;
  try {
    const [order] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
    if (!order) return null;

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const lines: ReceiptLine[] = items.map((it) => ({
      label: getProduct(it.sizeCode)?.labelInches ?? it.sizeCode,
      qty: it.quantity,
      lineTotal: money(it.lineTotalUsd),
    }));

    let customerName = order.contactName ?? 'there';
    if (!order.contactName && order.customerId) {
      const [c] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, order.customerId)).limit(1);
      customerName = c?.name ?? 'there';
    }
    const firstName = customerName.split(/\s+/)[0] ?? customerName;

    let fulfilment: string;
    if (order.fulfillmentMethod === 'delivery') {
      fulfilment = `Delivery\n${order.deliveryAddress ?? "We'll be in touch with the details."}`;
    } else {
      const point = await getOrderCollectionPoint(order.collectionPointId);
      fulfilment = point ? `Collection — ${point.name}\n${point.addressLine}` : `Collection\n${env.BUSINESS_NAME}`;
    }

    const dateStr = (order.paidAt ?? order.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

    const svg = buildReceiptSvg({
      orderNumber,
      dateStr,
      customerName: firstName,
      lines,
      subtotal: money(order.subtotalUsd),
      delivery: Number(order.deliveryFeeUsd) > 0 ? money(order.deliveryFeeUsd) : 'Free',
      total: money(order.totalUsd),
      fulfilment,
    });

    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const pdf = await PDFDocument.create();
    const img = await pdf.embedPng(png);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    const pdfBytes = await pdf.save();
    logger.info({ orderNumber }, 'Receipt PDF rendered');
    return Buffer.from(pdfBytes);
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to render receipt PDF');
    return null;
  }
}

/** Receipt PDF filename for an order (used as the email attachment + WhatsApp doc name). */
export function receiptPdfFilename(orderNumber: string): string {
  return `FusionPrints Receipt ${orderNumber}.pdf`;
}

/** Render the receipt PDF and upload it to B2. Returns the URL or null. */
export async function generateReceiptPdf(orderNumber: string): Promise<string | null> {
  const pdfBytes = await renderReceiptPdfBytes(orderNumber);
  if (!pdfBytes) return null;
  try {
    const key = `receipts/${orderNumber}-${randomUUID().slice(0, 8)}.pdf`;
    await s3.send(
      new PutObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: key, Body: pdfBytes, ContentType: 'application/pdf' }),
    );
    // 360dialog fetches this URL to deliver the document, so it must be publicly
    // reachable — the raw bucket URL is private (401), which silently drops the
    // WhatsApp receipt. Return a presigned GET URL (1h; the fetch is immediate).
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: key }), { expiresIn: 3600 });
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to upload receipt PDF');
    return null;
  }
}

/**
 * Generate + send the in-chat PDF receipt to a WhatsApp customer. No-ops for web
 * orders (they get the email receipt) and is best-effort.
 */
export async function sendWhatsAppReceipt(orderNumber: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order || !order.customerId) return;
  const [customer] = await db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1);
  if (!customer) return;

  const url = await generateReceiptPdf(orderNumber);
  if (!url) return;

  const to = customer.phoneNumber.replace(/^\+/, '');
  try {
    await sendWhatsAppDocument(to, url, `FusionPrints Receipt ${orderNumber}.pdf`, `Receipt for ${orderNumber} — thank you! 🧾`);
    logger.info({ orderNumber }, 'Sent in-chat WhatsApp receipt');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to send WhatsApp receipt document');
  }
}
