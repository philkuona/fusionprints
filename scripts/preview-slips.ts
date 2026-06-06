/** Render the order_info + end_separator cards to local PNGs (no B2 upload). */
import sharp from 'sharp';
import { buildOrderInfoSvg, buildEndSeparatorSvg } from '../src/services/slip-renderer.js';

const OUT = process.argv[2] ?? '/mnt/c/temp';

async function main() {
  // Sample data mirrors the approved mockup.
  const orderInfo = buildOrderInfoSvg({
    orderNumber: 'FP-2026-0042',
    customerName: 'Sarah Mukamuri',
    customerPhone: '+263 77 234 5678',
    paymentMethod: 'EcoCash',
    fulfillmentMethod: 'collection',
    items: [
      { quantity: 32, sizeLabel: '5×7 in prints' },
      { quantity: 2, sizeLabel: '11×14 wall print' },
    ],
    orderedAt: new Date(2026, 4, 2, 14, 32),
  });
  await sharp(Buffer.from(orderInfo)).png().toFile(`${OUT}/slip-order-info.png`);

  const sep = buildEndSeparatorSvg({ orderNumber: 'FP-2026-0042', customerFirstName: 'Sarah' });
  await sharp(Buffer.from(sep)).png().toFile(`${OUT}/slip-end-separator.png`);
  console.log(`wrote ${OUT}/slip-order-info.png and ${OUT}/slip-end-separator.png`);
}
main().catch((e) => { console.error(e); process.exit(1); });
