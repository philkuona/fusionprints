/**
 * Fulfillment classification + printer routing (Outsource Routing — Phase 1).
 *
 * Pins the catalog `fulfillment` field as the single source of truth for whether
 * a size is printed in-house (DNP) or sent to an outsource partner, and that the
 * print-job target-printer-type mapping agrees with it. Guards against a new size
 * being added without a routing decision, or the two drifting apart.
 */

import { describe, it, expect } from 'vitest';
import {
  PRODUCTS,
  IN_HOUSE_PRODUCTS,
  OUTSOURCED_PRODUCTS,
  isOutsourcedProduct,
  getTargetPrinterType,
  getProduct,
} from '@/config/catalog.js';

describe('fulfillment classification', () => {
  it('every product declares a fulfillment value', () => {
    for (const p of PRODUCTS) {
      expect(['in_house', 'outsource']).toContain(p.fulfillment);
    }
  });

  it('exactly the large/wall-art sizes are outsourced', () => {
    const outsourced = OUTSOURCED_PRODUCTS.map((p) => p.sizeCode).sort();
    expect(outsourced).toEqual(['11x14', '12x18', '16x20', '8x10'].sort());
  });

  it('in-house + outsourced partition the whole catalog', () => {
    expect(IN_HOUSE_PRODUCTS.length + OUTSOURCED_PRODUCTS.length).toBe(PRODUCTS.length);
  });

  it('all composites are in-house (printed on the DNP)', () => {
    for (const p of PRODUCTS.filter((x) => x.productType === 'composite')) {
      expect(p.fulfillment).toBe('in_house');
    }
  });
});

describe('printer routing agrees with fulfillment', () => {
  it('outsourced sizes have no in-house printer and never enter a print queue', () => {
    for (const p of OUTSOURCED_PRODUCTS) {
      expect(isOutsourcedProduct(p)).toBe(true);
      // No in-house printer — the Epson was retired; these go to a partner.
      expect(p.printer).toBeUndefined();
      // getTargetPrinterType is only ever called on in-house items; on an
      // outsourced product it refuses rather than inventing a queue.
      expect(() => getTargetPrinterType(p)).toThrow();
    }
  });

  it('in-house sizes route to a dye-sub queue', () => {
    for (const p of IN_HOUSE_PRODUCTS) {
      expect(isOutsourcedProduct(p)).toBe(false);
      expect(getTargetPrinterType(p)).toMatch(/^dye_sub_/);
    }
  });

  it('5×7 routes to the dedicated 5×7 dye-sub queue', () => {
    expect(getTargetPrinterType(getProduct('5x7')!)).toBe('dye_sub_5x7');
  });
});
