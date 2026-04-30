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
  | 'choosing_quantity'
  | 'adding_more_or_checkout'
  | 'collecting_name'
  | 'choosing_fulfillment'
  | 'collecting_address'
  | 'confirming_order'
  | 'awaiting_payment'
  | 'order_complete';

export type ProductType = 'photo_print' | 'poster';
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
   *  In the CLI simulator we use a placeholder string. */
  imageRef: string;
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
  /** Upload mode for the current item — single image with quantity, or batch */
  uploadMode?: 'single' | 'batch';
  /** Images collected so far in the current batch (for multi-upload mode) */
  pendingBatch?: BatchedImage[];
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
  /** Whether customer has chosen to use a compressed image anyway */
  acceptedCompressedImage?: boolean;
}

/** An empty starting context */
export function emptyContext(): BotContext {
  return {
    cart: [],
  };
}
