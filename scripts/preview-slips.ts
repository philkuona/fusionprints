/** Render order_info + end_separator to local PNGs (no B2). Matches Philip test order. */
import sharp from 'sharp';
import { buildOrderInfoSvg, buildEndSeparatorSvg } from '../src/services/slip-renderer.js';
const OUT = process.argv[2] ?? '/mnt/c/temp';
async function main() {
  const oi = buildOrderInfoSvg({
    orderNumber: 'FP-2026-0005', customerName: 'Philip Kuona', customerPhone: '+263 77 234 5678',
    paymentMethod: 'EcoCash', fulfillmentMethod: 'collection',
    items: [{ quantity: 1, sizeLabel: '4×6 in' }], orderedAt: new Date(2026, 5, 6, 18, 35),
  });
  await sharp(Buffer.from(oi)).png().toFile(`${OUT}/slip-order-info.png`);
  const sep = buildEndSeparatorSvg({ orderNumber: 'FP-2026-0005', customerFirstName: 'Philip' });
  await sharp(Buffer.from(sep)).png().toFile(`${OUT}/slip-end-separator.png`);
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
