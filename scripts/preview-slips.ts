import sharp from 'sharp';
import { buildOrderInfoSvg, buildEndSeparatorSvg, extractFirstName } from '../src/services/slip-renderer.js';
const OUT = process.argv[2] ?? '/mnt/c/temp';
async function main() {
  // Stress case: long email-as-name, VIRT order#, 6 items, long method.
  const oi = buildOrderInfoSvg({
    orderNumber: 'VIRT-FP-2026-0005', customerName: 'tatenda.nyaradzo.chikwambamukonde@gmail.com',
    customerPhone: '+263 77 234 5678', paymentMethod: 'Innbucks', fulfillmentMethod: 'delivery',
    items: [
      { quantity: 32, sizeLabel: '5×7 in prints' }, { quantity: 2, sizeLabel: '11×14 wall print' },
      { quantity: 4, sizeLabel: '8×10 in' }, { quantity: 1, sizeLabel: '12×18 in poster' },
      { quantity: 6, sizeLabel: '4×6 in' }, { quantity: 3, sizeLabel: '6×6 in' },
    ],
    orderedAt: new Date(2026, 5, 6, 18, 35),
  });
  await sharp(Buffer.from(oi)).png().toFile(`${OUT}/stress-order-info.png`);
  const sep = buildEndSeparatorSvg({ orderNumber: 'VIRT-FP-2026-0005', customerFirstName: extractFirstName('tatenda.nyaradzo.chikwambamukonde@gmail.com') });
  await sharp(Buffer.from(sep)).png().toFile(`${OUT}/stress-end-separator.png`);

  // Normal case again for sanity.
  const oi2 = buildOrderInfoSvg({
    orderNumber: 'FP-2026-0005', customerName: 'Philip Kuona', customerPhone: '+263 77 234 5678',
    paymentMethod: 'EcoCash', fulfillmentMethod: 'collection',
    items: [{ quantity: 1, sizeLabel: '4×6 in' }], orderedAt: new Date(2026, 5, 6, 18, 35),
  });
  await sharp(Buffer.from(oi2)).png().toFile(`${OUT}/slip-order-info.png`);
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
