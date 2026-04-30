/**
 * Pricing engine test script.
 *
 * Runs a series of test scenarios and prints the results.
 * No database, no WhatsApp, no external services — pure logic.
 *
 * Usage: npx tsx scripts/test-pricing.ts
 */

import { calculateQuote, getBulkDiscountPercent, formatPriceList } from '../src/services/pricing.js';

// Helper to print a section header
function section(title: string): void {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// Helper to print a quote result
function printQuote(label: string, result: ReturnType<typeof calculateQuote>): void {
  console.log(`\n📋 ${label}`);
  if (!result.ok) {
    console.log(`  ❌ Error [${result.error.type}]: ${result.error.message}`);
    return;
  }
  console.log(result.quote.summary);
  console.log(`\n  → requiresManualReview: ${result.quote.requiresManualReview}`);
  console.log(`  → hasOutsourcedItems: ${result.quote.hasOutsourcedItems}`);
  console.log(`  → bulkDiscountPercent: ${result.quote.bulkDiscountPercent}%`);
}

// ===== Test scenarios =====

section('PRICE LISTS');

console.log('\n' + formatPriceList('photo_print'));
console.log('\n' + formatPriceList('poster'));

section('BULK DISCOUNT TIERS');

const quantities = [1, 5, 9, 10, 25, 49, 50, 100];
for (const qty of quantities) {
  const discount = getBulkDiscountPercent(qty);
  console.log(`  ${qty.toString().padStart(3)} items → ${discount}% off`);
}

section('BASIC QUOTES');

printQuote(
  'Single 4×6 print, collection',
  calculateQuote([{ sizeCode: '4x6', quantity: 1 }], 'collection', 'collection'),
);

printQuote(
  '5 × 5×7 prints, collection',
  calculateQuote([{ sizeCode: '5x7', quantity: 5 }], 'collection', 'collection'),
);

printQuote(
  '1 × 8×10 photo, Harare CBD delivery',
  calculateQuote([{ sizeCode: '8x10', quantity: 1 }], 'delivery', 'harare_cbd'),
);

section('BULK DISCOUNT SCENARIOS');

printQuote(
  '10 × 4×6 prints (hits 15% discount tier)',
  calculateQuote([{ sizeCode: '4x6', quantity: 10 }], 'collection', 'collection'),
);

printQuote(
  '50 × 4×6 prints (hits 25% discount tier)',
  calculateQuote([{ sizeCode: '4x6', quantity: 50 }], 'collection', 'collection'),
);

printQuote(
  'Mixed order: 30 × 4×6 + 5 × 5×7 = 35 items (15% discount)',
  calculateQuote(
    [
      { sizeCode: '4x6', quantity: 30 },
      { sizeCode: '5x7', quantity: 5 },
    ],
    'collection',
    'collection',
  ),
);

section('POSTER ORDERS (manual review required)');

printQuote(
  '1 × 11×14 poster, collection',
  calculateQuote([{ sizeCode: '11x14', quantity: 1 }], 'collection', 'collection'),
);

printQuote(
  '1 × 16×20 poster, greater Harare delivery',
  calculateQuote([{ sizeCode: '16x20', quantity: 1 }], 'delivery', 'harare_greater'),
);

section('OUTSOURCED ITEMS');

printQuote(
  '1 × 24×36 poster (outsourced, 5–7 days)',
  calculateQuote([{ sizeCode: '24x36', quantity: 1 }], 'collection', 'collection'),
);

section('MIXED PHOTO + POSTER ORDER');

printQuote(
  '20 × 4×6 + 1 × 11×14 poster, collection',
  calculateQuote(
    [
      { sizeCode: '4x6', quantity: 20 },
      { sizeCode: '11x14', quantity: 1 },
    ],
    'collection',
    'collection',
  ),
);

section('ERROR CASES');

printQuote(
  'Invalid size code',
  calculateQuote([{ sizeCode: 'banana', quantity: 1 }], 'collection', 'collection'),
);

printQuote(
  'Zero quantity',
  calculateQuote([{ sizeCode: '4x6', quantity: 0 }], 'collection', 'collection'),
);

printQuote(
  'Empty cart',
  calculateQuote([], 'collection', 'collection'),
);

printQuote(
  'Invalid delivery zone',
  calculateQuote([{ sizeCode: '4x6', quantity: 1 }], 'delivery', 'moon'),
);

section('DONE');
console.log('\n✅ All test scenarios printed above.');
console.log('Check the totals manually against the pricing model in docs/project-state.md\n');
