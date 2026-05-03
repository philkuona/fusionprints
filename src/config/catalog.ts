/**
 * FusionPrints Product Catalog
 *
 * This is the single source of truth for every product we sell.
 * When you want to add a size, change a price, or change which
 * printer handles a product — this is the only file you edit.
 *
 * Sizes are always stored internally in inches (the print industry standard)
 * but displayed to customers in both inches and centimetres.
 */

export type ProductType = 'photo_print' | 'poster';
export type FulfillmentMethod = 'collection' | 'delivery';

export interface Product {
  /** Internal code used in the database and bot logic e.g. '4x6' */
  sizeCode: string;
  productType: ProductType;
  /** Display label in inches */
  labelInches: string;
  /** Display label in centimetres */
  labelCm: string;
  /** Full display label shown to customers e.g. "4×6 in (10×15 cm)" */
  displayLabel: string;
  /** Price per single unit in USD */
  unitPriceUsd: number;
  /** Which printer handles this product */
  printer: 'dnp_ds620a_4x6' | 'dnp_ds620a_5x7' | 'epson_p900';
  /** Print finish — locked per size at launch (Phase 2 may allow customer choice) */
  finish: 'glossy' | 'lustre';
  /** Whether this product needs human approval before printing */
  requiresManualReview: boolean;
  /**
   * Legacy field — kept for backward compatibility. Always false at launch
   * since outsourcing was removed (decided 2026-05-02).
   * Will be removed in a future migration.
   */
  isOutsourced: boolean;
  /** Minimum image resolution in pixels for acceptable quality */
  minResolution: { width: number; height: number };
  /** Recommended image resolution for best quality */
  recommendedResolution: { width: number; height: number };
}

/**
 * The complete product catalog (current as of 2026-05-02).
 *
 * Architecture (locked):
 *   - DNP #1 with 6×8 master media → handles 4×6 (cut), 6×6 (cut), 6×8 (native)
 *   - DNP #2 with 5×7 media        → handles 5×7
 *   - Epson SC-P900                 → handles 8×10, 11×14, 12×18, 16×20
 *
 * Catalog at launch — 8 sizes total. Outsourced sizes (18×24, 24×36) were
 * dropped after we decided not to outsource (no SA partner). Customers get
 * a clean "everything is printed in-house" story.
 *
 * Print finishes locked per size:
 *   - 4×6 → glossy (consumer snapshot use)
 *   - 6×6, 5×7, 6×8 → lustre (album / wall use)
 *   - 8×10 and up → lustre (Epson lustre paper)
 *
 * Customer-choosable finishes deferred to Phase 2.
 */
export const PRODUCTS: Product[] = [
  // ===== Photo Prints (DNP) =====
  {
    sizeCode: '4x6',
    productType: 'photo_print',
    labelInches: '4×6 in',
    labelCm: '10×15 cm',
    displayLabel: '4×6 in (10×15 cm)',
    unitPriceUsd: 0.80,
    printer: 'dnp_ds620a_4x6',
    finish: 'glossy',
    requiresManualReview: false,
    isOutsourced: false,
    minResolution: { width: 600, height: 900 },
    recommendedResolution: { width: 1200, height: 1800 },
  },
  {
    sizeCode: '5x7',
    productType: 'photo_print',
    labelInches: '5×7 in',
    labelCm: '13×18 cm',
    displayLabel: '5×7 in (13×18 cm)',
    unitPriceUsd: 2.00,
    printer: 'dnp_ds620a_5x7',
    finish: 'lustre',
    requiresManualReview: false,
    isOutsourced: false,
    minResolution: { width: 750, height: 1050 },
    recommendedResolution: { width: 1500, height: 2100 },
  },
  {
    sizeCode: '6x6',
    productType: 'photo_print',
    labelInches: '6×6 in',
    labelCm: '15×15 cm',
    displayLabel: '6×6 in (15×15 cm)',
    unitPriceUsd: 2.00,
    printer: 'dnp_ds620a_4x6',
    finish: 'lustre',
    requiresManualReview: false,
    isOutsourced: false,
    minResolution: { width: 900, height: 900 },
    recommendedResolution: { width: 1800, height: 1800 },
  },
  {
    sizeCode: '6x8',
    productType: 'photo_print',
    labelInches: '6×8 in',
    labelCm: '15×20 cm',
    displayLabel: '6×8 in (15×20 cm)',
    unitPriceUsd: 2.50,
    printer: 'dnp_ds620a_4x6',
    finish: 'lustre',
    requiresManualReview: false,
    isOutsourced: false,
    minResolution: { width: 900, height: 1200 },
    recommendedResolution: { width: 1800, height: 2400 },
  },
  {
    sizeCode: '8x10',
    productType: 'photo_print',
    labelInches: '8×10 in',
    labelCm: '20×25 cm',
    displayLabel: '8×10 in (20×25 cm)',
    unitPriceUsd: 5.00,
    printer: 'epson_p900',
    finish: 'lustre',
    requiresManualReview: false,
    isOutsourced: false,
    minResolution: { width: 1200, height: 1500 },
    recommendedResolution: { width: 2400, height: 3000 },
  },

  // ===== Posters (Epson) =====
  {
    sizeCode: '11x14',
    productType: 'poster',
    labelInches: '11×14 in',
    labelCm: '28×36 cm',
    displayLabel: '11×14 in (28×36 cm)',
    unitPriceUsd: 10.00,
    printer: 'epson_p900',
    finish: 'lustre',
    requiresManualReview: true,
    isOutsourced: false,
    minResolution: { width: 1650, height: 2100 },
    recommendedResolution: { width: 3300, height: 4200 },
  },
  {
    sizeCode: '12x18',
    productType: 'poster',
    labelInches: '12×18 in',
    labelCm: '30×45 cm',
    displayLabel: '12×18 in (30×45 cm)',
    unitPriceUsd: 14.00,
    printer: 'epson_p900',
    finish: 'lustre',
    requiresManualReview: true,
    isOutsourced: false,
    minResolution: { width: 1800, height: 2700 },
    recommendedResolution: { width: 3600, height: 5400 },
  },
  {
    sizeCode: '16x20',
    productType: 'poster',
    labelInches: '16×20 in',
    labelCm: '40×50 cm',
    displayLabel: '16×20 in (40×50 cm)',
    unitPriceUsd: 22.00,
    printer: 'epson_p900',
    finish: 'lustre',
    requiresManualReview: true,
    isOutsourced: false,
    minResolution: { width: 2400, height: 3000 },
    recommendedResolution: { width: 4800, height: 6000 },
  },
];

/** Quick lookup: get a product by its sizeCode. Returns undefined if not found. */
export function getProduct(sizeCode: string): Product | undefined {
  return PRODUCTS.find((p) => p.sizeCode === sizeCode);
}

/** All photo print products */
export const PHOTO_PRODUCTS = PRODUCTS.filter((p) => p.productType === 'photo_print');

/** All poster products */
export const POSTER_PRODUCTS = PRODUCTS.filter((p) => p.productType === 'poster');

/** In-house products only (not outsourced) */
export const IN_HOUSE_PRODUCTS = PRODUCTS.filter((p) => !p.isOutsourced);

/**
 * Delivery fees in USD.
 * Keyed by zone name which matches what the bot presents to the customer.
 */
export const DELIVERY_FEES: Record<string, number> = {
  collection: 0,
  harare_cbd: 3.00,
  harare_greater: 5.00,
  outside_harare: 0, // quote-based — handled manually
};

/**
 * Bulk discount tiers.
 * Applied to the total quantity across ALL items in an order, not per-item.
 *
 * Example: 12 × 4x6 + 5 × 5x7 = 17 items total → 15% discount
 */
export const BULK_DISCOUNT_TIERS = [
  { minQuantity: 50, discountPercent: 25 },
  { minQuantity: 10, discountPercent: 15 },
  { minQuantity: 1, discountPercent: 0 },   // baseline — no discount
];
