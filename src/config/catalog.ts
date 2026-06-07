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

// 'composite' = multi-cell products (wallet/passport/mini) the agent renders
// onto one sheet. (The schema brief calls single prints 'standard'; we keep the
// established 'photo_print' value to avoid churning the DB enum + bot.)
export type ProductType = 'photo_print' | 'poster' | 'composite';
export type FulfillmentMethod = 'collection' | 'delivery';

// ===== Composite layout types (source of truth: FusionPrints_Composite_Schema.ts) =====

/** How the DEFAULT (WhatsApp) flow maps uploaded photos onto cells. */
export type PhotoMappingMode =
  | 'duplicate'   // 1 photo duplicated across N cells
  | 'unique'      // N photos, 1 per cell
  | 'set_repeat'; // M photos in a set, repeated across cell groups

export interface LayoutCell {
  /** Position from top-left of the sheet, in inches. */
  x: number;
  y: number;
  /** Cell size in inches. */
  width: number;
  height: number;
  /** Which uploaded photo (0-based) fills this cell in the default flow. */
  photoIndex: number;
}

export interface BorderOption {
  id: string;
  displayName: string;
  widthInches: number;
  color: string;
  style: 'solid' | 'dashed';
}

export interface EditorConfig {
  perCellUpload: boolean;
  perCellTransform: boolean;
  fillAllShortcut: boolean;
  borderOptions: BorderOption[];
  /** Border applied on load (usually 'none'). */
  defaultBorder: string;
}

export interface PrintLayout {
  /** Layout identifier the agent compositor switches on. */
  type: string;
  cellCount: number;
  /** Unique photos the WhatsApp default flow collects. */
  photosRequired: number;
  photoMapping: PhotoMappingMode;
  /** White space between cells, inches (cutting tolerance). */
  gutter: number;
  /** Composites always render baked-in cut lines. */
  showCutLines: boolean;
  /** Composed sheet size in inches (mini is composed landscape 6×4). */
  sheetWidth: number;
  sheetHeight: number;
  /** Degrees the agent rotates the composed sheet before printing (mini = 90). */
  printRotation: 0 | 90;
  cells: LayoutCell[];
  /** Web-editor behaviour (Phase 2). */
  editor?: EditorConfig;
}

/** Standard border presets, reusable across composite products. */
export const BORDER_PRESETS: BorderOption[] = [
  { id: 'none', displayName: 'No border', widthInches: 0, color: 'transparent', style: 'solid' },
  { id: 'white_thin', displayName: 'Thin white', widthInches: 0.05, color: '#FBF7F0', style: 'solid' },
  { id: 'white_thick', displayName: 'Polaroid', widthInches: 0.2, color: '#FBF7F0', style: 'solid' },
  { id: 'black_thin', displayName: 'Thin black', widthInches: 0.05, color: '#1F1B16', style: 'solid' },
  { id: 'vintage', displayName: 'Vintage cream', widthInches: 0.12, color: '#E8DBC0', style: 'solid' },
];

/** Default editor config shared by all composite products. */
export const DEFAULT_COMPOSITE_EDITOR: EditorConfig = {
  perCellUpload: true,
  perCellTransform: true,
  fillAllShortcut: true,
  borderOptions: BORDER_PRESETS,
  defaultBorder: 'none',
};

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
  /**
   * Customer-facing product name + blurb. Single sizes use displayLabel; the
   * composite products carry a richer brand-voice name/description.
   */
  displayName?: string;
  description?: string;
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
  /** Composite layout — present only for productType 'composite'. */
  layout?: PrintLayout;
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

  // ===== Composite Prints (DNP 4×6, server-side compositing) =====
  // All print on the existing 4×6 DNP media; the agent renders multiple cells
  // onto one sheet with baked-in cut lines. minResolution/recommendedResolution
  // are per the photo that fills a single cell (the smallest unit a photo maps to).
  {
    sizeCode: 'wallet_4up',
    productType: 'composite',
    labelInches: '2×3 in × 4',
    labelCm: '5×8 cm × 4',
    displayLabel: 'Wallet Prints (Set of 4)',
    displayName: 'Wallet Prints (Set of 4)',
    description: 'Four classic 2×3 wallet-sized prints on a single 4×6 sheet. Cut along the guides for four keepsakes.',
    unitPriceUsd: 2.50,
    printer: 'dnp_ds620a_4x6',
    finish: 'glossy',
    requiresManualReview: false,
    isOutsourced: false,
    minResolution: { width: 400, height: 600 },
    recommendedResolution: { width: 600, height: 900 },
    layout: {
      type: '4up_wallet',
      cellCount: 4,
      photosRequired: 1,
      photoMapping: 'duplicate',
      gutter: 0.05,
      showCutLines: true,
      sheetWidth: 4,
      sheetHeight: 6,
      printRotation: 0,
      cells: [
        { x: 0, y: 0, width: 2, height: 3, photoIndex: 0 },
        { x: 2, y: 0, width: 2, height: 3, photoIndex: 0 },
        { x: 0, y: 3, width: 2, height: 3, photoIndex: 0 },
        { x: 2, y: 3, width: 2, height: 3, photoIndex: 0 },
      ],
      editor: DEFAULT_COMPOSITE_EDITOR,
    },
  },
  {
    sizeCode: 'passport_6up',
    productType: 'composite',
    labelInches: '2×2 in × 6',
    labelCm: '5×5 cm × 6',
    displayLabel: 'Passport Photos (Set of 6)',
    displayName: 'Passport Photos (Set of 6)',
    description: 'Six 2×2 inch passport-style photos on a single 4×6 sheet. Standard ID size, same photo.',
    unitPriceUsd: 3.00,
    printer: 'dnp_ds620a_4x6',
    finish: 'glossy',
    requiresManualReview: false,
    isOutsourced: false,
    minResolution: { width: 400, height: 400 },
    recommendedResolution: { width: 600, height: 600 },
    layout: {
      type: '6up_passport',
      cellCount: 6,
      photosRequired: 1,
      photoMapping: 'duplicate',
      gutter: 0.05,
      showCutLines: true,
      sheetWidth: 4,
      sheetHeight: 6,
      printRotation: 0,
      cells: [
        { x: 0, y: 0, width: 2, height: 2, photoIndex: 0 },
        { x: 2, y: 0, width: 2, height: 2, photoIndex: 0 },
        { x: 0, y: 2, width: 2, height: 2, photoIndex: 0 },
        { x: 2, y: 2, width: 2, height: 2, photoIndex: 0 },
        { x: 0, y: 4, width: 2, height: 2, photoIndex: 0 },
        { x: 2, y: 4, width: 2, height: 2, photoIndex: 0 },
      ],
      editor: DEFAULT_COMPOSITE_EDITOR,
    },
  },
  {
    sizeCode: 'mini_pair',
    productType: 'composite',
    labelInches: '3×4 in × 2',
    labelCm: '8×10 cm × 2',
    displayLabel: 'Mini Prints (Pair)',
    displayName: 'Mini Prints (Pair)',
    description: 'Two mini prints side by side on one 4×6 sheet, 3×4 each. Cut down the middle for two prints to keep or share.',
    unitPriceUsd: 2.00,
    printer: 'dnp_ds620a_4x6',
    finish: 'glossy',
    requiresManualReview: false,
    isOutsourced: false,
    minResolution: { width: 600, height: 800 },
    recommendedResolution: { width: 900, height: 1200 },
    layout: {
      // Composed landscape (6 wide × 4 tall); the agent rotates 90° to print on
      // portrait-fed 4×6 paper.
      type: '2_landscape_side_by_side',
      cellCount: 2,
      photosRequired: 2,
      photoMapping: 'unique',
      gutter: 0.05,
      showCutLines: true,
      sheetWidth: 6,
      sheetHeight: 4,
      printRotation: 90,
      cells: [
        { x: 0, y: 0, width: 3, height: 4, photoIndex: 0 },
        { x: 3, y: 0, width: 3, height: 4, photoIndex: 1 },
      ],
      editor: DEFAULT_COMPOSITE_EDITOR,
    },
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

/** All composite products (wallet / passport / mini). */
export const COMPOSITE_PRODUCTS = PRODUCTS.filter((p) => p.productType === 'composite');

/** Type guard: does this product render as a multi-cell composite? */
export function isComposite(product: Product): boolean {
  return product.productType === 'composite' && !!product.layout;
}

/** In-house products only (not outsourced) */
export const IN_HOUSE_PRODUCTS = PRODUCTS.filter((p) => !p.isOutsourced);

/**
 * Map a product's printer field to the database's target_printer_type enum value.
 * Used by Phase D multi-printer routing to tag print_jobs with their destination.
 *
 * Catalog uses printer values: 'dnp_ds620a_4x6' | 'dnp_ds620a_5x7' | 'epson_p900'
 * Database uses target_printer_type: 'dye_sub_4x6' | 'dye_sub_5x7' | 'inkjet' | 'thermal_label'
 *
 * The mapping is straightforward — printer field describes the physical printer,
 * target_printer_type describes the routing category (multiple printers can share a type).
 */
export type TargetPrinterType = 'dye_sub_4x6' | 'dye_sub_5x7' | 'inkjet' | 'thermal_label';

export function getTargetPrinterType(product: Product): TargetPrinterType {
  switch (product.printer) {
    case 'dnp_ds620a_4x6':
      return 'dye_sub_4x6';
    case 'dnp_ds620a_5x7':
      return 'dye_sub_5x7';
    case 'epson_p900':
      return 'inkjet';
    default: {
      // exhaustive check — TypeScript will error if a new printer value is added
      // without a corresponding case here
      const _exhaustive: never = product.printer;
      throw new Error(`Unknown printer type: ${_exhaustive}`);
    }
  }
}

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
