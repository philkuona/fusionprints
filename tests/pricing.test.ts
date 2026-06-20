/**
 * pricing.calculateQuote — the money function (audit IMP-1, wave 1).
 *
 * Pure: prices come from config/catalog PRODUCTS (4x6 = $0.80, 5x7 = $2.00
 * at the time of writing — assertions derive from the catalog, not literals,
 * so admin price changes don't break the suite; the structural/rounding/zone
 * behaviour is what's pinned).
 */

import { describe, it, expect } from 'vitest';
import { calculateQuote } from '@/services/pricing.js';
import { getProduct, DELIVERY_FEES } from '@/config/catalog.js';

const p4x6 = getProduct('4x6')!;
const p5x7 = getProduct('5x7')!;

describe('calculateQuote — input validation', () => {
  it('rejects an empty cart', () => {
    const r = calculateQuote([], 'collection', 'collection');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('EMPTY_CART');
  });

  it('rejects unknown SKUs', () => {
    const r = calculateQuote([{ sizeCode: '9x99', quantity: 1 }], 'collection', 'collection');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('INVALID_SKU');
  });

  it.each([0, -1, 1.5, NaN])('rejects quantity %p', (quantity) => {
    const r = calculateQuote([{ sizeCode: '4x6', quantity }], 'collection', 'collection');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('INVALID_QUANTITY');
  });

  it('rejects delivery to an unknown zone', () => {
    const r = calculateQuote([{ sizeCode: '4x6', quantity: 1 }], 'delivery', 'narnia');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('INVALID_DELIVERY_ZONE');
  });

  it('ignores the zone for collection orders', () => {
    const r = calculateQuote([{ sizeCode: '4x6', quantity: 1 }], 'collection', 'narnia');
    expect(r.ok).toBe(true);
  });
});

describe('calculateQuote — totals', () => {
  it('prices a single line correctly', () => {
    const r = calculateQuote([{ sizeCode: '4x6', quantity: 10 }], 'collection', 'collection');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.subtotalUsd).toBeCloseTo(p4x6.unitPriceUsd * 10, 2);
    expect(r.quote.deliveryFeeUsd).toBe(0);
    expect(r.quote.totalUsd).toBe(r.quote.discountedSubtotalUsd);
    expect(r.quote.totalQuantity).toBe(10);
  });

  it('sums mixed lines', () => {
    const r = calculateQuote(
      [
        { sizeCode: '4x6', quantity: 3 },
        { sizeCode: '5x7', quantity: 2 },
      ],
      'collection',
      'collection',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = p4x6.unitPriceUsd * 3 + p5x7.unitPriceUsd * 2;
    expect(r.quote.subtotalUsd).toBeCloseTo(expected, 2);
    expect(r.quote.totalQuantity).toBe(5);
    expect(r.quote.items).toHaveLength(2);
  });

  it('rounds money to cents (no floating-point dust)', () => {
    // 3 × 0.80 = 2.4000000000000004 in raw IEEE 754 — the quote must be exact.
    const r = calculateQuote([{ sizeCode: '4x6', quantity: 3 }], 'collection', 'collection');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cents = r.quote.subtotalUsd * 100;
    expect(cents).toBeCloseTo(Math.round(cents), 9);
    expect(String(r.quote.subtotalUsd)).not.toMatch(/\d{3,}$/); // no long tail
  });

  it.each(Object.entries(DELIVERY_FEES).filter(([z]) => z !== 'collection'))(
    'adds the %s delivery fee (%p)',
    (zone, fee) => {
      const r = calculateQuote([{ sizeCode: '4x6', quantity: 1 }], 'delivery', zone);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.quote.deliveryFeeUsd).toBe(fee);
      expect(r.quote.totalUsd).toBeCloseTo(r.quote.discountedSubtotalUsd + fee, 2);
    },
  );
});

describe('calculateQuote — bulk discount (currently disabled)', () => {
  // Pins today's intentional state: every tier is 0%. If tiers are
  // re-enabled in catalog.ts this fails on purpose — update deliberately.
  it.each([1, 9, 10, 49, 50, 500])('applies 0%% at quantity %i', (quantity) => {
    const r = calculateQuote([{ sizeCode: '4x6', quantity }], 'collection', 'collection');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.bulkDiscountPercent).toBe(0);
    expect(r.quote.bulkDiscountAmountUsd).toBe(0);
    expect(r.quote.discountedSubtotalUsd).toBe(r.quote.subtotalUsd);
  });
});

describe('calculateQuote — flags and summary', () => {
  it('propagates manual-review and outsourced flags', () => {
    const r = calculateQuote([{ sizeCode: '4x6', quantity: 1 }], 'collection', 'collection');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.requiresManualReview).toBe(p4x6.requiresManualReview);
    expect(r.quote.hasOutsourcedItems).toBe(p4x6.isOutsourced);
  });

  it('produces a non-empty human summary', () => {
    const r = calculateQuote([{ sizeCode: '4x6', quantity: 2 }], 'collection', 'collection');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.summary.length).toBeGreaterThan(0);
    expect(r.quote.summary).toContain(p4x6.displayLabel);
  });
});

describe('calculateQuote — order minimums', () => {
  const mins = { pickupUsd: 2, deliveryUsd: 5 };

  it('skips the minimum check when minimums are not supplied (back-compat)', () => {
    // 4x6 = $0.80, below any floor, but no minimums passed → allowed.
    const r = calculateQuote([{ sizeCode: '4x6', quantity: 1 }], 'collection', 'collection');
    expect(r.ok).toBe(true);
  });

  it('rejects a pickup order below the pickup minimum', () => {
    const r = calculateQuote([{ sizeCode: '4x6', quantity: 1 }], 'collection', 'collection', mins);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('BELOW_MINIMUM');
  });

  it('accepts a pickup order at the pickup minimum', () => {
    // 5x7 = $2.00 == pickup minimum.
    const r = calculateQuote([{ sizeCode: '5x7', quantity: 1 }], 'collection', 'collection', mins);
    expect(r.ok).toBe(true);
  });

  it('accepts a delivery order above the delivery minimum', () => {
    const zone = Object.keys(DELIVERY_FEES)[0];
    // 5x7 × 3 = $6 + delivery fee, comfortably above $5.
    const r = calculateQuote([{ sizeCode: '5x7', quantity: 3 }], 'delivery', zone, mins);
    expect(r.ok).toBe(true);
  });
});
