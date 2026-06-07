/**
 * Bot context types.
 *
 * The `context` field in conversation_state is JSONB — it holds whatever
 * the bot needs to remember between messages for the current conversation.
 *
 * This file defines the TypeScript types for that context so the rest of
 * the code is type-safe when reading/writing it.
 */

export type BotStep =
  | 'idle'
  | 'greeted'
  | 'choosing_product'
  | 'choosing_size'
  | 'choosing_upload_mode'
  | 'awaiting_image'
  | 'collecting_image_batch'
  | 'awaiting_web_upload'
  // Composite product flows (wallet/passport = 1 photo; mini = 2 photos)
  | 'choosing_wallet_photo'
  | 'choosing_passport_photo'
  | 'choosing_mini_photo_1'
  | 'choosing_mini_photo_2'
  | 'choosing_quantity'
  | 'adding_more_or_checkout'
  | 'collecting_name'
  | 'choosing_fulfillment'
  | 'collecting_address'
  | 'confirming_order'
  | 'choosing_payment_method'
  | 'entering_ecocash_number'
  | 'awaiting_ecocash_pin'
  | 'awaiting_payment'
  | 'order_complete';

export type ProductType = 'photo_print' | 'poster' | 'composite';
export type FulfillmentMethod = 'collection' | 'delivery';

/** A single item the customer has added to their cart */
export interface CartItem {
  sizeCode: string;
  displayLabel: string;
  quantity: number;
  unitPriceUsd: number;
  lineTotalUsd: number;
  requiresManualReview: boolean;
  /** Image reference — in real system this is the image UUID from the DB.
   *  In the CLI simulator we use a placeholder string.
   *  For composites this is the first cell's image (kept for back-compat). */
  imageRef: string;
  /**
   * Composite products only: which image fills each cell. Used to build
   * order_items.layout_payload. Duplicate-mapping products (wallet/passport)
   * repeat one ref across all cells; mini carries two distinct refs.
   */
  compositeCells?: { cellIndex: number; imageRef: string }[];
}

/** A single image collected during multi-upload mode */
export interface BatchedImage {
  ref: string;
  widthPx: number;
  heightPx: number;
  /** True if image is below recommended resolution (still acceptable) */
  qualityWarning: boolean;
}

/** The bot's working memory for a conversation in progress */
export interface BotContext {
  /** What product type the customer is currently selecting */
  pendingProductType?: ProductType;
  /** What size they've selected, pending image upload */
  pendingSize?: string;
  /** Upload mode for the current item — single image with quantity, batch via WhatsApp, or web link */
  uploadMode?: 'single' | 'batch' | 'web';
  /** Images collected so far in the current batch (for multi-upload mode) */
  pendingBatch?: BatchedImage[];
  /** Image refs collected so far for the current composite (e.g. mini photo 1). */
  pendingCompositePhotos?: string[];
  /** Items confirmed and added to cart */
  cart: CartItem[];
  /** Customer's chosen fulfillment method */
  fulfillmentMethod?: FulfillmentMethod;
  /** Delivery zone if delivery chosen */
  deliveryZone?: string;
  /** Delivery address if delivery chosen */
  deliveryAddress?: string;
  /** Order number once created */
  orderNumber?: string;
  /** Payment method chosen at checkout */
  paymentMethod?: 'ecocash' | 'card';
  /** Customer's EcoCash mobile number (normalized to +263...) */
  ecocashNumber?: string;
  /** Whether customer has chosen to use a compressed image anyway */
  acceptedCompressedImage?: boolean;
  /** Previous step — used by the BACK keyword to navigate one step back */
  _previousStep?: string;
}

/** An empty starting context */
export function emptyContext(): BotContext {
  return {
    cart: [],
  };
}
