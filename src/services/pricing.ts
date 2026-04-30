/**
 * FusionPrints Pricing Engine
 *
 * Pure functions — no database calls, no side effects, no external dependencies.
 * Input goes in, prices come out. Easy to test, easy to reason about.
 *
 * The bot calls these functions to:
 *   1. Quote a price before the customer commits
 *   2. Calculate the final total when creating an order
 *   3. Validate that a cart is sensible before payment
 */

import {
  PRODUCTS,
  BULK_DISCOUNT_TIERS,
  DELIVERY_FEES,
  getProduct,
  type FulfillmentMethod,
} from '@/config/catalog.js';

// ===== Input / Output types =====

export interface CartItem {
  sizeCode: string;
  quantity: number;
}

export interface PricedItem {
  sizeCode: string;
  displayLabel: string;
  productType: string;
  quantity: number;
  unitPriceUsd: number;
  lineTotalUsd: number;
  requiresManualReview: boolean;
  isOutsourced: boolean;
}

export interface OrderQuote {
  items: PricedItem[];
  subtotalUsd: number;
  totalQuantity: number;
  bulkDiscountPercent: number;
  bulkDiscountAmountUsd: number;
  discountedSubtotalUsd: number;
  deliveryFeeUsd: number;
  totalUsd: number;
  fulfillmentMethod: FulfillmentMethod;
  deliveryZone: string;
  requiresManualReview: boolean; // true if any item needs approval
  hasOutsourcedItems: boolean;   // true if any item is outsourced
  /** Human-readable summary for the bot to send to the customer */
  summary: string;
}

export interface PricingError {
  type: 'INVALID_SKU' | 'INVALID_QUANTITY' | 'EMPTY_CART' | 'INVALID_DELIVERY_ZONE';
  message: string;
  sizeCode?: string;
}

export type PricingResult =
  | { ok: true; quote: OrderQuote }
  | { ok: false; error: PricingError };

// ===== Core functions =====

/**
 * Calculate the bulk discount percentage for a given total quantity.
 * Finds the highest tier whose minQuantity is met.
 */
export function getBulkDiscountPercent(totalQuantity: number): number {
  for (const tier of BULK_DISCOUNT_TIERS) {
    if (totalQuantity >= tier.minQuantity) {
      return tier.discountPercent;
    }
  }
  return 0;
}

/**
 * Round a number to 2 decimal places (money-safe).
 * Never use floating-point arithmetic directly on money.
 */
function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Get the delivery fee for a given zone and fulfillment method.
 */
export function getDeliveryFee(fulfillmentMethod: FulfillmentMethod, zone: string): number {
  if (fulfillmentMethod === 'collection') return 0;
  return DELIVERY_FEES[zone] ?? 0;
}

/**
 * Calculate a full order quote from a list of cart items.
 *
 * Returns either a complete quote or a descriptive error.
 *
 * Example:
 *   calculateQuote(
 *     [{ sizeCode: '4x6', quantity: 10 }, { sizeCode: '5x7', quantity: 3 }],
 *     'collection',
 *     'collection'
 *   )
 */
export function calculateQuote(
  items: CartItem[],
  fulfillmentMethod: FulfillmentMethod,
  deliveryZone: string,
): PricingResult {
  // --- Validate inputs ---

  if (items.length === 0) {
    return {
      ok: false,
      error: { type: 'EMPTY_CART', message: 'No items in cart.' },
    };
  }

  if (fulfillmentMethod === 'delivery' && !(deliveryZone in DELIVERY_FEES)) {
    return {
      ok: false,
      error: {
        type: 'INVALID_DELIVERY_ZONE',
        message: `Unknown delivery zone: ${deliveryZone}`,
      },
    };
  }

  // --- Price each item ---

  const pricedItems: PricedItem[] = [];

  for (const item of items) {
    if (item.quantity < 1 || !Number.isInteger(item.quantity)) {
      return {
        ok: false,
        error: {
          type: 'INVALID_QUANTITY',
          message: `Quantity must be a whole number of at least 1 (got ${item.quantity} for ${item.sizeCode}).`,
          sizeCode: item.sizeCode,
        },
      };
    }

    const product = getProduct(item.sizeCode);
    if (!product) {
      return {
        ok: false,
        error: {
          type: 'INVALID_SKU',
          message: `Unknown product size: ${item.sizeCode}`,
          sizeCode: item.sizeCode,
        },
      };
    }

    const lineTotal = roundMoney(product.unitPriceUsd * item.quantity);

    pricedItems.push({
      sizeCode: item.sizeCode,
      displayLabel: product.displayLabel,
      productType: product.productType,
      quantity: item.quantity,
      unitPriceUsd: product.unitPriceUsd,
      lineTotalUsd: lineTotal,
      requiresManualReview: product.requiresManualReview,
      isOutsourced: product.isOutsourced,
    });
  }

  // --- Calculate totals ---

  const subtotal = roundMoney(
    pricedItems.reduce((sum, item) => sum + item.lineTotalUsd, 0),
  );

  const totalQuantity = pricedItems.reduce((sum, item) => sum + item.quantity, 0);

  const discountPercent = getBulkDiscountPercent(totalQuantity);
  const discountAmount = roundMoney(subtotal * (discountPercent / 100));
  const discountedSubtotal = roundMoney(subtotal - discountAmount);

  const deliveryFee = getDeliveryFee(fulfillmentMethod, deliveryZone);
  const total = roundMoney(discountedSubtotal + deliveryFee);

  const requiresManualReview = pricedItems.some((i) => i.requiresManualReview);
  const hasOutsourcedItems = pricedItems.some((i) => i.isOutsourced);

  // --- Build the human-readable summary for the bot ---

  const summary = buildSummary({
    items: pricedItems,
    subtotalUsd: subtotal,
    totalQuantity,
    bulkDiscountPercent: discountPercent,
    bulkDiscountAmountUsd: discountAmount,
    discountedSubtotalUsd: discountedSubtotal,
    deliveryFeeUsd: deliveryFee,
    totalUsd: total,
    fulfillmentMethod,
    deliveryZone,
    requiresManualReview,
    hasOutsourcedItems,
    summary: '', // filled below
  });

  return {
    ok: true,
    quote: {
      items: pricedItems,
      subtotalUsd: subtotal,
      totalQuantity,
      bulkDiscountPercent: discountPercent,
      bulkDiscountAmountUsd: discountAmount,
      discountedSubtotalUsd: discountedSubtotal,
      deliveryFeeUsd: deliveryFee,
      totalUsd: total,
      fulfillmentMethod,
      deliveryZone,
      requiresManualReview,
      hasOutsourcedItems,
      summary,
    },
  };
}

/**
 * Build a WhatsApp-ready order summary string.
 * This is exactly what the bot sends to the customer before they confirm.
 */
function buildSummary(quote: OrderQuote): string {
  const lines: string[] = [];

  lines.push('📋 *Order Summary*');
  lines.push('');

  for (const item of quote.items) {
    const emoji = item.productType === 'photo_print' ? '📷' : '🖼️';
    const outsourcedNote = item.isOutsourced ? ' _(5–7 day turnaround)_' : '';
    lines.push(
      `${emoji} ${item.quantity} × ${item.displayLabel} — $${item.lineTotalUsd.toFixed(2)}${outsourcedNote}`,
    );
  }

  lines.push('');

  if (quote.bulkDiscountPercent > 0) {
    lines.push(`Subtotal: $${quote.subtotalUsd.toFixed(2)}`);
    lines.push(
      `Bulk discount (${quote.bulkDiscountPercent}% off ${quote.totalQuantity} items): -$${quote.bulkDiscountAmountUsd.toFixed(2)}`,
    );
  }

  if (quote.deliveryFeeUsd > 0) {
    lines.push(`Delivery: $${quote.deliveryFeeUsd.toFixed(2)}`);
  } else if (quote.fulfillmentMethod === 'collection') {
    lines.push(`Collection: Free`);
  }

  lines.push('');
  lines.push(`*Total: $${quote.totalUsd.toFixed(2)}*`);

  if (quote.requiresManualReview) {
    lines.push('');
    lines.push(
      '⚠️ _Poster orders require a quick quality check before printing (within 2 hours, business hours)._',
    );
  }

  if (quote.hasOutsourcedItems) {
    lines.push('');
    lines.push(
      '📦 _Large format items (18×24 and 24×36) are fulfilled by our partner lab. Allow 5–7 days._',
    );
  }

  return lines.join('\n');
}

/**
 * Format a price list for display in the bot.
 * Used when the customer asks "what are your prices?" or browses sizes.
 */
export function formatPriceList(productType: 'photo_print' | 'poster'): string {
  const products = PRODUCTS.filter((p) => p.productType === productType);
  const emoji = productType === 'photo_print' ? '📷' : '🖼️';
  const title = productType === 'photo_print' ? 'Photo Prints' : 'Posters';

  const lines: string[] = [`${emoji} *${title}*`, ''];

  products.forEach((p, index) => {
    const outsourcedNote = p.isOutsourced ? ' _(order by request)_' : '';
    lines.push(`${index + 1}️⃣ ${p.displayLabel} — $${p.unitPriceUsd.toFixed(2)}${outsourcedNote}`);
  });

  lines.push('');
  lines.push('_Bulk discounts: 10–49 items = 15% off, 50+ items = 25% off_');

  return lines.join('\n');
}

/**
 * Get a single product's price as a formatted string.
 * Used in the bot after a customer selects a size.
 */
export function formatUnitPrice(sizeCode: string): string | null {
  const product = getProduct(sizeCode);
  if (!product) return null;
  return `$${product.unitPriceUsd.toFixed(2)} each`;
}
