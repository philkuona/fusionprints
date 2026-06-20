/**
 * FusionPrints Bot State Machine
 *
 * This is the brain of the customer-facing bot. Every message a customer
 * sends flows through here. It reads the current conversation state,
 * processes the message, and returns:
 *   - The bot's reply (one or more messages)
 *   - The new conversation step
 *   - The updated context (cart, pending selections, etc.)
 *
 * Design principles:
 *   - Pure function: given state + message → new state + replies
 *   - No database calls inside handlers (DB is the caller's job)
 *   - No WhatsApp API calls (the transport layer's job)
 *   - Every step is an explicit case — no magic, no ambiguity
 *   - When in doubt, ask the customer to clarify
 */

import { PHOTO_PRODUCTS, POSTER_PRODUCTS, getProduct } from '@/config/catalog.js';
import { calculateQuote } from '@/services/pricing.js';
import { validateImage } from '@/services/image-validation.js';
import { isEcocashCapable } from '@/utils/phone.js';
import { MSG } from './messages.js';
import type { BotStep, BotContext, CartItem } from './types.js';
import { emptyContext } from './types.js';

// ===== Types =====

export interface IncomingMessage {
  /** The raw text from the customer (already trimmed) */
  text: string;
  /** If the customer sent an image/document */
  image?: {
    widthPx: number;
    heightPx: number;
    wasCompressed: boolean;
    /** Reference to stored image — UUID in production, placeholder in CLI */
    ref: string;
  };
}

/**
 * A single reply from the bot.
 * Strings are sent as plain text messages.
 * Objects with buttons/list become WhatsApp interactive messages.
 */
export type BotReply =
  | string
  | {
      text: string;
      buttons: { id: string; title: string }[];
    }
  | {
      text: string;
      list: {
        buttonText: string;
        sections: {
          title?: string;
          rows: { id: string; title: string; description?: string }[];
        }[];
      };
    };

export interface BotResponse {
  /** Messages to send back to the customer, in order */
  replies: BotReply[];
  /** New conversation step */
  nextStep: BotStep;
  /** Updated context */
  nextContext: BotContext;
  /** Side effects to trigger (caller handles these) */
  effects: BotEffect[];
}

export type BotEffect =
  | { type: 'CREATE_ORDER'; quote: ReturnType<typeof calculateQuote> }
  | { type: 'INITIATE_PAYMENT'; orderNumber: string }
  | { type: 'INITIATE_ECOCASH_PAYMENT'; orderNumber: string; ecocashNumber: string }
  | { type: 'CANCEL_ORDER'; orderNumber: string | undefined }
  | { type: 'LOOKUP_ORDER_STATUS'; phone: string }
  | { type: 'create_upload_link'; sizeCode: string; displayLabel: string }
  | { type: 'resolve_web_upload' };

// ===== Main handler =====

/**
 * Process one incoming message and return the bot's response.
 *
 * @param step    - current conversation step
 * @param context - current conversation context (cart, pending selections, etc.)
 * @param message - the incoming message from the customer
 * @param customer - customer info from the database (null if first contact)
 */
export function handleMessage(
  step: BotStep,
  context: BotContext,
  message: IncomingMessage,
  customer: { name: string | null; email: string | null } | null,
): BotResponse {
  const text = message.text.trim().toUpperCase();

  // ===== Reset shortcut — greetings restart the conversation =====
  // BUT never silently discard a cart or an in-progress order: a confused
  // customer typing "Hi" mid-payment would otherwise lose their order number
  // (and an order that may already be charging is orphaned). For those, ask
  // before discarding; only an explicit RESTART clears.
  const RESET_WORDS = ['HI', 'HELLO', 'HEY', 'START', 'MENU', 'RESTART', 'HIE', 'HOLA', 'YO'];
  if (RESET_WORDS.includes(text)) {
    const midOrder = (context.cart?.length ?? 0) > 0 || !!context.orderNumber;
    if (midOrder && text !== 'RESTART') {
      return reply(
        MSG.resetGuard(context.orderNumber ?? null, context.cart?.length ?? 0),
        step,
        context,
      );
    }
    return handleIdle(emptyContext(), customer);
  }

  // ===== Global commands — work from any step =====

  if (text === 'HELP') {
    return reply(MSG.humanHandoff(), step, context);
  }

  if (text === 'CANCEL') {
    return {
      replies: [MSG.orderCancelled()],
      nextStep: 'idle',
      nextContext: emptyContext(),
      effects: context.orderNumber
        ? [{ type: 'CANCEL_ORDER', orderNumber: context.orderNumber }]
        : [],
    };
  }

  if (text === 'STATUS' || text === 'WHERE IS MY ORDER' || text === 'WHERE IS MY PRINT') {
    return {
      replies: [MSG.noRecentOrders()],
      nextStep: step,
      nextContext: context,
      effects: [{ type: 'LOOKUP_ORDER_STATUS', phone: '' }],
    };
  }

  if (text === 'BACK' || text === '← BACK' || text === 'GO BACK' || text === 'PREVIOUS') {
    return handleBack(step, context, customer);
  }

  // ===== Step handlers =====

  switch (step) {
    case 'idle':
    case 'order_complete':
      return handleIdle(context, customer);

    case 'greeted':
    case 'choosing_product':
      return handleChoosingProduct(text, context, customer);

    case 'choosing_size':
      return handleChoosingSize(text, context);

    case 'choosing_upload_mode':
      return handleChoosingUploadMode(text, context);

    case 'awaiting_image':
      return handleAwaitingImage(text, message, context);

    case 'choosing_wallet_photo':
    case 'choosing_passport_photo':
      return handleCompositeSinglePhoto(text, message, context);

    case 'choosing_mini_photo_1':
      return handleMiniPhoto1(text, message, context);

    case 'choosing_mini_photo_2':
      return handleMiniPhoto2(text, message, context);

    case 'collecting_image_batch':
      return handleCollectingImageBatch(text, message, context);

    case 'awaiting_web_upload':
      return handleAwaitingWebUpload(text, context);

    case 'choosing_quantity':
      return handleChoosingQuantity(text, context);

    case 'adding_more_or_checkout':
      return handleAddMoreOrCheckout(text, context, customer);

    case 'collecting_name':
      return handleCollectingName(text, context, customer);

    case 'collecting_email':
      return handleCollectingEmail(text, context, customer);

    case 'choosing_fulfillment':
      return handleChoosingFulfillment(text, context);

    case 'collecting_address':
      return handleCollectingAddress(message.text.trim(), context);

    case 'confirming_order':
      return handleConfirmingOrder(text, context);

    case 'choosing_payment_method':
      return handleChoosingPaymentMethod(text, context);

    case 'entering_ecocash_number':
      return handleEnteringEcocashNumber(text, context);

    case 'awaiting_ecocash_pin':
      return handleAwaitingEcocashPin(text, context);

    case 'awaiting_payment':
      return handleAwaitingPayment(text, context);

    default:
      return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  }
}

// ===== Step handlers =====

/**
 * Handle the BACK command — go to the previous step in the flow.
 * Uses a static map of "what's the previous step" rather than tracking history,
 * because the flow is linear with predictable previous steps.
 *
 * Special handling:
 *   - From the start (idle, choosing_product) — already at root, just show greeting
 *   - From batch upload with photos already taken — warn before discarding
 *   - From awaiting_payment — destructive, ask for CANCEL instead
 */
function handleBack(
  step: BotStep,
  context: BotContext,
  customer: { name: string | null; email: string | null } | null,
): BotResponse {
  switch (step) {
    case 'idle':
    case 'order_complete':
    case 'choosing_product':
      // Already at root — just show greeting again
      return reply(
        MSG.greetingInteractive(customer?.name ?? undefined),
        'choosing_product',
        emptyContext(),
      );

    case 'choosing_size':
    case 'choosing_wallet_photo':
    case 'choosing_passport_photo':
    case 'choosing_mini_photo_1':
    case 'choosing_mini_photo_2':
      // Back to the main product menu (composites have no size sub-step)
      return reply(
        MSG.greetingInteractive(customer?.name ?? undefined),
        'choosing_product',
        { ...context, pendingProductType: undefined, pendingSize: undefined, pendingCompositePhotos: undefined },
      );

    case 'choosing_upload_mode':
    case 'awaiting_image':
    case 'awaiting_web_upload': {
      // Back to size selection
      const products =
        context.pendingProductType === 'poster' ? POSTER_PRODUCTS : PHOTO_PRODUCTS;
      void products; // avoid unused warning
      return reply(
        context.pendingProductType === 'poster'
          ? MSG.posterSizeMenuInteractive()
          : MSG.photoSizeMenuInteractive(),
        'choosing_size',
        { ...context, pendingSize: undefined, uploadMode: undefined },
      );
    }

    case 'collecting_image_batch': {
      // If they have photos in the batch, warn before discarding
      const batchSize = context.pendingBatch?.length ?? 0;
      if (batchSize > 0) {
        return reply(
          `⚠️ You've already uploaded ${batchSize} photo${batchSize === 1 ? '' : 's'} in this batch.\n\nGoing back will discard them. Reply *CONTINUE* to keep uploading, or *DISCARD* to start over.`,
          'collecting_image_batch',
          context,
        );
      }
      // No photos yet — go back cleanly
      return reply(
        context.pendingProductType === 'poster'
          ? MSG.posterSizeMenuInteractive()
          : MSG.photoSizeMenuInteractive(),
        'choosing_size',
        { ...context, pendingSize: undefined, uploadMode: undefined, pendingBatch: undefined },
      );
    }

    case 'choosing_quantity': {
      // Back to image upload — re-prompt for the photo
      const product = getProduct(context.pendingSize ?? '');
      if (!product) {
        return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
      }
      const priceLabel = `$${product.unitPriceUsd.toFixed(2)}`;
      return reply(
        MSG.awaitingImage(product.displayLabel, priceLabel),
        'awaiting_image',
        context,
      );
    }

    case 'adding_more_or_checkout':
      // Back to product selection (start a new item)
      return reply(
        MSG.greetingInteractive(customer?.name ?? undefined),
        'choosing_product',
        { ...context, pendingProductType: undefined, pendingSize: undefined },
      );

    case 'collecting_name':
      // Back to checkout/cart screen
      return reply(
        MSG.addMoreOrCheckoutInteractive(),
        'adding_more_or_checkout',
        context,
      );

    case 'collecting_email':
      // Back to checkout/cart screen
      return reply(
        MSG.addMoreOrCheckoutInteractive(),
        'adding_more_or_checkout',
        context,
      );

    case 'choosing_fulfillment': {
      // Back to checkout decision
      return reply(
        MSG.addMoreOrCheckoutInteractive(),
        'adding_more_or_checkout',
        context,
      );
    }

    case 'collecting_address':
      // Back to fulfillment options
      return reply(
        MSG.chooseFulfillmentInteractive(customer?.name ?? 'there'),
        'choosing_fulfillment',
        { ...context, fulfillmentMethod: undefined, deliveryAddress: undefined },
      );

    case 'confirming_order':
      // Back to fulfillment selection
      return reply(
        MSG.chooseFulfillmentInteractive(customer?.name ?? 'there'),
        'choosing_fulfillment',
        { ...context, fulfillmentMethod: undefined },
      );

    case 'choosing_payment_method':
    case 'entering_ecocash_number':
    case 'awaiting_ecocash_pin':
      // Order has already been created — destructive
      return reply(
        `Order *${context.orderNumber}* has been created.\n\nReply *CANCEL* to cancel the order and start over.`,
        step,
        context,
      );

    case 'awaiting_payment':
      // Destructive — direct customer to use CANCEL instead
      return reply(
        `Going back from here would cancel your pending order *${context.orderNumber}*.\n\nReply *CANCEL* to cancel the order, or pay using the link above.`,
        'awaiting_payment',
        context,
      );

    default:
      // Unknown step — go to greeting as a safe fallback
      return reply(
        MSG.greetingInteractive(customer?.name ?? undefined),
        'choosing_product',
        emptyContext(),
      );
  }
}

function handleIdle(
  _context: BotContext,
  customer: { name: string | null; email: string | null } | null,
): BotResponse {
  return reply(MSG.greetingInteractive(customer?.name ?? undefined), 'choosing_product', emptyContext());
}

function handleChoosingProduct(
  text: string,
  context: BotContext,
  customer: { name: string | null; email: string | null } | null,
): BotResponse {
  // Accept the interactive list ids, typed numbers (1-6), or natural words.
  if (text === '1' || text === 'PHOTOS' || text === 'PHOTO' || text === 'PHOTO PRINTS') {
    return reply(MSG.photoSizeMenuInteractive(), 'choosing_size', {
      ...context,
      pendingProductType: 'photo_print',
    });
  }

  if (text === '2' || text === 'WALLET' || text === 'WALLET PRINTS') {
    return startCompositeFlow('wallet_4up', 'choosing_wallet_photo', context);
  }

  if (text === '3' || text === 'PASSPORT' || text === 'PASSPORT PHOTOS') {
    return startCompositeFlow('passport_6up', 'choosing_passport_photo', context);
  }

  if (text === '4' || text === 'MINI' || text === 'MINI PRINTS') {
    return startCompositeFlow('mini_pair', 'choosing_mini_photo_1', context);
  }

  if (text === '5' || text === 'POSTERS' || text === 'POSTER' || text === 'WALL ART') {
    return reply(MSG.posterSizeMenuInteractive(), 'choosing_size', {
      ...context,
      pendingProductType: 'poster',
    });
  }

  if (text === '6' || text === 'STATUS' || text === 'ORDER') {
    return {
      replies: [MSG.noRecentOrders()],
      nextStep: 'choosing_product',
      nextContext: context,
      effects: [{ type: 'LOOKUP_ORDER_STATUS', phone: '' }],
    };
  }

  // They typed something else — re-show the greeting
  return reply(MSG.greetingInteractive(customer?.name ?? undefined), 'choosing_product', context);
}

// ===== Composite product flows (wallet / passport / mini) =====

/** Price label helper. */
function priceOf(sizeCode: string): string {
  const p = getProduct(sizeCode);
  return p ? `$${p.unitPriceUsd.toFixed(2)}` : '';
}

/** Begin a composite flow: set the pending size and prompt for the first photo. */
function startCompositeFlow(
  sizeCode: string,
  nextStep: BotStep,
  context: BotContext,
): BotResponse {
  const product = getProduct(sizeCode);
  if (!product) {
    return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  }
  const name = product.displayName ?? product.displayLabel;
  const price = priceOf(sizeCode);
  const prompt =
    nextStep === 'choosing_mini_photo_1'
      ? MSG.miniPhoto1Prompt(name, price)
      : MSG.compositePhotoPrompt(name, price);
  return reply(prompt, nextStep, {
    ...context,
    pendingProductType: 'composite',
    pendingSize: sizeCode,
    pendingCompositePhotos: [],
  });
}

/**
 * Validate an incoming composite photo. Returns either an error response to
 * send back (and stay on the same step) or the accepted image ref.
 */
function acceptCompositePhoto(
  message: IncomingMessage,
  product: NonNullable<ReturnType<typeof getProduct>>,
  step: BotStep,
  context: BotContext,
  repromptText: string,
): { error: BotResponse } | { ref: string } {
  if (!message.image) {
    return { error: reply(repromptText, step, context) };
  }
  const { widthPx, heightPx, wasCompressed, ref } = message.image;
  if (wasCompressed) {
    return { error: reply(MSG.compositeImageCompressed(), step, context) };
  }
  const validation = validateImage(widthPx, heightPx, product.sizeCode, false);
  if (validation.quality === 'bad') {
    return {
      error: reply(
        MSG.compositeImageTooLow(widthPx, heightPx, product.minResolution.width, product.minResolution.height),
        step,
        context,
      ),
    };
  }
  return { ref };
}

/** Build a composite cart item with one ref per layout cell. */
function buildCompositeCartItem(
  product: NonNullable<ReturnType<typeof getProduct>>,
  refsByCell: string[],
): CartItem {
  const cells = (product.layout?.cells ?? []).map((cell, i) => ({
    cellIndex: i,
    // duplicate mapping → photoIndex 0 for every cell; unique mapping → per-cell photo
    imageRef: refsByCell[cell.photoIndex] ?? refsByCell[0],
  }));
  return {
    sizeCode: product.sizeCode,
    displayLabel: product.displayName ?? product.displayLabel,
    quantity: 1,
    unitPriceUsd: product.unitPriceUsd,
    lineTotalUsd: product.unitPriceUsd,
    requiresManualReview: product.requiresManualReview,
    imageRef: cells[0]?.imageRef ?? refsByCell[0],
    compositeCells: cells,
  };
}

/** Wallet / passport: one photo, duplicated across all cells. */
function handleCompositeSinglePhoto(
  _text: string,
  message: IncomingMessage,
  context: BotContext,
): BotResponse {
  const product = getProduct(context.pendingSize ?? '');
  if (!product) return reply(MSG.somethingWentWrong(), 'idle', emptyContext());

  const step: BotStep = product.sizeCode === 'passport_6up' ? 'choosing_passport_photo' : 'choosing_wallet_photo';
  const name = product.displayName ?? product.displayLabel;
  const result = acceptCompositePhoto(
    message,
    product,
    step,
    context,
    MSG.compositePhotoPrompt(name, priceOf(product.sizeCode)),
  );
  if ('error' in result) return result.error;

  const item = buildCompositeCartItem(product, [result.ref]);
  const newCart = [...context.cart, item];
  const cartTotal = newCart.reduce((s, i) => s + i.lineTotalUsd, 0);
  const newContext: BotContext = {
    ...context,
    cart: newCart,
    pendingProductType: undefined,
    pendingSize: undefined,
    pendingCompositePhotos: undefined,
  };
  return reply(MSG.itemAddedInteractive(item, `$${cartTotal.toFixed(2)}`), 'adding_more_or_checkout', newContext);
}

/** Mini prints: first of two photos. */
function handleMiniPhoto1(
  _text: string,
  message: IncomingMessage,
  context: BotContext,
): BotResponse {
  const product = getProduct(context.pendingSize ?? 'mini_pair');
  if (!product) return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  const name = product.displayName ?? product.displayLabel;
  const result = acceptCompositePhoto(
    message,
    product,
    'choosing_mini_photo_1',
    context,
    MSG.miniPhoto1Prompt(name, priceOf(product.sizeCode)),
  );
  if ('error' in result) return result.error;

  return reply(MSG.miniPhoto2Prompt(), 'choosing_mini_photo_2', {
    ...context,
    pendingCompositePhotos: [result.ref],
  });
}

/** Mini prints: second photo → add the pair to the cart. */
function handleMiniPhoto2(
  _text: string,
  message: IncomingMessage,
  context: BotContext,
): BotResponse {
  const product = getProduct(context.pendingSize ?? 'mini_pair');
  if (!product) return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  const result = acceptCompositePhoto(
    message,
    product,
    'choosing_mini_photo_2',
    context,
    MSG.miniPhoto2Prompt(),
  );
  if ('error' in result) return result.error;

  const firstRef = context.pendingCompositePhotos?.[0];
  if (!firstRef) {
    // Lost the first photo somehow — restart the mini flow cleanly.
    return startCompositeFlow('mini_pair', 'choosing_mini_photo_1', context);
  }

  const item = buildCompositeCartItem(product, [firstRef, result.ref]);
  const newCart = [...context.cart, item];
  const cartTotal = newCart.reduce((s, i) => s + i.lineTotalUsd, 0);
  const newContext: BotContext = {
    ...context,
    cart: newCart,
    pendingProductType: undefined,
    pendingSize: undefined,
    pendingCompositePhotos: undefined,
  };
  return reply(MSG.itemAddedInteractive(item, `$${cartTotal.toFixed(2)}`), 'adding_more_or_checkout', newContext);
}

function handleChoosingSize(text: string, context: BotContext): BotResponse {
  const products =
    context.pendingProductType === 'photo_print' ? PHOTO_PRODUCTS : POSTER_PRODUCTS;

  const choice = parseInt(text, 10);
  if (isNaN(choice) || choice < 1 || choice > products.length) {
    const menu =
      context.pendingProductType === 'photo_print'
        ? MSG.photoSizeMenuInteractive()
        : MSG.posterSizeMenuInteractive();
    return {
      replies: [MSG.invalidSizeChoice(products.length), menu],
      nextStep: 'choosing_size',
      nextContext: context,
      effects: [],
    };
  }

  const product = products[choice - 1];
  const priceLabel = `$${product.unitPriceUsd.toFixed(2)}`;

  return reply(
    MSG.chooseUploadModeInteractive(product.displayLabel, priceLabel),
    'choosing_upload_mode',
    { ...context, pendingSize: product.sizeCode },
  );
}

function handleChoosingUploadMode(text: string, context: BotContext): BotResponse {
  const product = getProduct(context.pendingSize ?? '');
  if (!product) {
    return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  }
  const priceLabel = `$${product.unitPriceUsd.toFixed(2)}`;

  if (text === '1' || text === 'ONE' || text === 'SINGLE') {
    // Single image, multiple copies path
    return reply(MSG.awaitingImage(product.displayLabel, priceLabel), 'awaiting_image', {
      ...context,
      uploadMode: 'single',
    });
  }

  if (text === '2' || text === 'MULTIPLE' || text === 'MANY') {
    // Multiple images via WhatsApp documents
    return reply(
      MSG.awaitingBatchUpload(product.displayLabel, priceLabel),
      'collecting_image_batch',
      {
        ...context,
        uploadMode: 'batch',
        pendingBatch: [],
      },
    );
  }

  if (text === '3' || text === 'WEB' || text === 'LINK') {
    // Web upload via browser link — return special effect that handler will resolve
    return {
      replies: [],
      nextStep: 'awaiting_web_upload',
      nextContext: {
        ...context,
        uploadMode: 'web',
      },
      effects: [{ type: 'create_upload_link', sizeCode: product.sizeCode, displayLabel: product.displayLabel }],
    };
  }

  return {
    replies: [
      MSG.invalidUploadMode(),
      MSG.chooseUploadModeInteractive(product.displayLabel, priceLabel),
    ],
    nextStep: 'choosing_upload_mode',
    nextContext: context,
    effects: [],
  };
}

/**
 * Handler for when the customer is uploading via the web link.
 * They tap the "✅ I've uploaded" button (id WEB_UPLOAD_DONE) when done — or
 * type any reasonable variant (uploaded/done/finished/…), so a typed reply
 * still resumes the flow instead of becoming a dead end.
 */
function handleAwaitingWebUpload(text: string, context: BotContext): BotResponse {
  const t = text.trim().toLowerCase();
  const isDone =
    text === 'WEB_UPLOAD_DONE' || // interactive button payload
    ['uploaded', 'done', 'finished', 'ready', 'complete', 'completed', '✅', "i've uploaded", 'ive uploaded'].includes(t);

  if (!isDone) {
    return reply(
      MSG.webUploadStillWaiting(),
      'awaiting_web_upload',
      context,
    );
  }

  // Return effect to resolve session images and continue
  return {
    replies: [],
    nextStep: 'awaiting_web_upload',
    nextContext: context,
    effects: [{ type: 'resolve_web_upload' }],
  };
}

function handleCollectingImageBatch(
  text: string,
  message: IncomingMessage,
  context: BotContext,
): BotResponse {
  const product = getProduct(context.pendingSize ?? '');
  if (!product) {
    return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  }

  const batch = context.pendingBatch ?? [];

  // Handle response to back-confirmation
  if (text === 'CONTINUE' || text === 'KEEP') {
    // Customer wants to keep their batch — re-show the batch upload prompt
    const priceLabel = `$${product.unitPriceUsd.toFixed(2)}`;
    return reply(
      MSG.awaitingBatchUpload(product.displayLabel, priceLabel),
      'collecting_image_batch',
      context,
    );
  }

  if (text === 'DISCARD' || text === 'START OVER') {
    // Customer confirmed they want to discard the batch and go back
    return reply(
      context.pendingProductType === 'poster'
        ? MSG.posterSizeMenuInteractive()
        : MSG.photoSizeMenuInteractive(),
      'choosing_size',
      { ...context, pendingSize: undefined, uploadMode: undefined, pendingBatch: undefined },
    );
  }

  // Customer is done uploading
  if (text === 'DONE' || text === 'FINISH' || text === 'FINISHED') {
    if (batch.length === 0) {
      return reply(MSG.batchEmptyOnDone(), 'collecting_image_batch', context);
    }

    // Fan the batch out into the cart
    const newCart = [...context.cart];
    for (const img of batch) {
      newCart.push({
        sizeCode: product.sizeCode,
        displayLabel: product.displayLabel,
        quantity: 1,
        unitPriceUsd: product.unitPriceUsd,
        lineTotalUsd: product.unitPriceUsd,
        requiresManualReview: product.requiresManualReview,
        imageRef: img.ref,
      });
    }

    const lineTotal = product.unitPriceUsd * batch.length;
    const lineTotalLabel = `$${lineTotal.toFixed(2)}`;
    const cartTotal = newCart.reduce((sum, item) => sum + item.lineTotalUsd, 0);
    const cartTotalLabel = `$${cartTotal.toFixed(2)}`;

    const newContext: BotContext = {
      ...context,
      cart: newCart,
      pendingProductType: undefined,
      pendingSize: undefined,
      uploadMode: undefined,
      pendingBatch: undefined,
      acceptedCompressedImage: undefined,
    };

    return reply(
      MSG.batchAdded(batch.length, product.displayLabel, lineTotalLabel, cartTotalLabel),
      'adding_more_or_checkout',
      newContext,
    );
  }

  // No image attached
  if (!message.image) {
    const priceLabel = `$${product.unitPriceUsd.toFixed(2)}`;
    return reply(
      MSG.awaitingBatchUpload(product.displayLabel, priceLabel),
      'collecting_image_batch',
      context,
    );
  }

  const { widthPx, heightPx, wasCompressed, ref } = message.image;

  // Compressed image — reject this one but keep the batch
  if (wasCompressed) {
    return reply(MSG.batchImageRejectedCompressed(), 'collecting_image_batch', context);
  }

  // Validate against the chosen print size
  const validation = validateImage(widthPx, heightPx, product.sizeCode, false);

  if (validation.quality === 'bad') {
    return reply(
      MSG.batchImageRejectedTooLow(
        widthPx,
        heightPx,
        product.minResolution.width,
        product.minResolution.height,
      ),
      'collecting_image_batch',
      context,
    );
  }

  // Image acceptable — add to batch
  const newImage = {
    ref,
    widthPx,
    heightPx,
    qualityWarning: validation.quality === 'warn',
  };
  const newBatch = [...batch, newImage];
  const count = newBatch.length;

  // Throttle replies: always reply on first image, then every 5th,
  // then a reminder every 10th at high volume.
  // This avoids flooding the customer with 200 individual confirmations.
  let reply_msg: string;
  if (count === 1) {
    // Always confirm the first one so customer knows it's working
    reply_msg = MSG.batchImageAdded(count, widthPx, heightPx, newImage.qualityWarning);
  } else if (count % 10 === 0) {
    // Every 10th image: progress update with count and reminder to DONE
    reply_msg = MSG.batchProgressUpdate(count);
  } else if (count % 5 === 0) {
    // Every 5th: silent progress (no reply — let WhatsApp batch the messages)
    // We skip sending a reply here intentionally
    return {
      replies: [],
      nextStep: 'collecting_image_batch',
      nextContext: { ...context, pendingBatch: newBatch },
      effects: [],
    };
  } else {
    // All others: no reply — customer is busy selecting, don't interrupt
    return {
      replies: [],
      nextStep: 'collecting_image_batch',
      nextContext: { ...context, pendingBatch: newBatch },
      effects: [],
    };
  }

  return {
    replies: [reply_msg],
    nextStep: 'collecting_image_batch',
    nextContext: { ...context, pendingBatch: newBatch },
    effects: [],
  };
}

function handleAwaitingImage(
  text: string,
  message: IncomingMessage,
  context: BotContext,
): BotResponse {
  // Customer said "use anyway" after a compression or quality warning
  if (text === 'USE ANYWAY' || text === '2' && context.acceptedCompressedImage !== undefined) {
    // Use a placeholder image ref — in production this would be the already-uploaded image
    return reply(MSG.imageOkNoCheck(), 'choosing_quantity', {
      ...context,
      acceptedCompressedImage: true,
    });
  }

  // Customer sent "1" to send a different photo
  if (text === '1') {
    const product = getProduct(context.pendingSize ?? '');
    const priceLabel = product ? `$${product.unitPriceUsd.toFixed(2)}` : '';
    return reply(
      MSG.awaitingImage(product?.displayLabel ?? 'your print', priceLabel),
      'awaiting_image',
      { ...context, acceptedCompressedImage: undefined },
    );
  }

  // No image attached and no recognised command
  if (!message.image) {
    const product = getProduct(context.pendingSize ?? '');
    const priceLabel = product ? `$${product.unitPriceUsd.toFixed(2)}` : '';
    return reply(
      MSG.awaitingImage(product?.displayLabel ?? 'your print', priceLabel),
      'awaiting_image',
      context,
    );
  }

  // Image received — validate it
  const { widthPx, heightPx, wasCompressed, ref } = message.image;
  const sizeCode = context.pendingSize ?? '';

  if (wasCompressed) {
    return reply(MSG.imageWasCompressed(), 'awaiting_image', {
      ...context,
      acceptedCompressedImage: false,
    });
  }

  const validation = validateImage(widthPx, heightPx, sizeCode, false);
  const product = getProduct(sizeCode);

  if (validation.quality === 'bad' && product) {
    return reply(
      MSG.imageTooLow(
        widthPx,
        heightPx,
        product.minResolution.width,
        product.minResolution.height,
      ),
      'awaiting_image',
      { ...context, acceptedCompressedImage: false },
    );
  }

  if (validation.quality === 'warn' && product) {
    return reply(
      MSG.imageWarnLow(
        widthPx,
        heightPx,
        product.recommendedResolution.width,
        product.recommendedResolution.height,
      ),
      'awaiting_image',
      { ...context, acceptedCompressedImage: false },
    );
  }

  // Image is good — move to quantity
  // Store the image ref so we can attach it to the cart item
  return reply(MSG.imageOk(widthPx, heightPx), 'choosing_quantity', {
    ...context,
    pendingSize: sizeCode,
    // We temporarily store the image ref in context until quantity is confirmed
    _pendingImageRef: ref,
  } as BotContext & { _pendingImageRef: string });
}

function handleChoosingQuantity(text: string, context: BotContext): BotResponse {
  const qty = parseInt(text, 10);
  if (isNaN(qty) || qty < 1) {
    return reply(MSG.invalidQuantity(), 'choosing_quantity', context);
  }

  const sizeCode = context.pendingSize ?? '';
  const product = getProduct(sizeCode);

  if (!product) {
    return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  }

  const lineTotal = Math.round(product.unitPriceUsd * qty * 100) / 100;
  // Pull the pending image ref out of context (we stored it temporarily)
  const imageRef = (context as BotContext & { _pendingImageRef?: string })._pendingImageRef ?? 'pending';

  const newItem: CartItem = {
    sizeCode,
    displayLabel: product.displayLabel,
    quantity: qty,
    unitPriceUsd: product.unitPriceUsd,
    lineTotalUsd: lineTotal,
    requiresManualReview: product.requiresManualReview,
    imageRef,
  };

  const newCart = [...context.cart, newItem];

  // Calculate running cart total
  const cartTotal = newCart.reduce((sum, item) => sum + item.lineTotalUsd, 0);
  const cartTotalLabel = `$${cartTotal.toFixed(2)}`;

  const newContext: BotContext = {
    ...context,
    cart: newCart,
    pendingProductType: undefined,
    pendingSize: undefined,
    acceptedCompressedImage: undefined,
  };

  return reply(MSG.itemAddedInteractive(newItem, cartTotalLabel), 'adding_more_or_checkout', newContext);
}

function handleAddMoreOrCheckout(
  text: string,
  context: BotContext,
  customer: { name: string | null; email: string | null } | null,
): BotResponse {
  if (text === '1' || text === 'ADD' || text === 'MORE' || text === 'ADD MORE') {
    return reply(MSG.greetingInteractive(customer?.name ?? undefined), 'choosing_product', context);
  }

  if (text === '2' || text === 'CHECKOUT' || text === 'DONE' || text === 'NEXT') {
    // We need full name + email before fulfillment (for the order + the QBO
    // customer record). Ask for whichever is missing, in order.
    if (!customer?.name) {
      return reply(MSG.askName(), 'collecting_name', context);
    }
    if (!customer?.email) {
      return reply(MSG.askEmail(), 'collecting_email', context);
    }
    return reply(
      MSG.chooseFulfillmentInteractive(customer.name),
      'choosing_fulfillment',
      context,
    );
  }

  return reply(MSG.addMoreOrCheckoutInteractive(), 'adding_more_or_checkout', context);
}

function handleCollectingName(
  text: string,
  context: BotContext,
  customer: { name: string | null; email: string | null } | null,
): BotResponse {
  const name = text.trim();
  if (!name || name.length < 2) {
    return reply(MSG.invalidName(), 'collecting_name', context);
  }

  // Capitalise first letter of each word
  const formattedName = name
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

  // Note: saving the name to the database is an effect the caller handles.
  // We pass it through context for the fulfillment message.
  const newContext = { ...context, _customerName: formattedName } as BotContext & {
    _customerName: string;
  };

  // Still need their email before fulfillment.
  if (!customer?.email) {
    return reply(MSG.askEmail(), 'collecting_email', newContext);
  }
  return reply(
    MSG.chooseFulfillmentInteractive(formattedName),
    'choosing_fulfillment',
    newContext,
  );
}

function handleCollectingEmail(
  text: string,
  context: BotContext,
  customer: { name: string | null; email: string | null } | null,
): BotResponse {
  const email = text.trim();
  // Permissive local@domain.tld check — good enough to catch typos/non-emails.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply(MSG.invalidEmail(), 'collecting_email', context);
  }

  // Saving to the DB is an effect the caller handles; pass via context.
  const newContext = { ...context, _customerEmail: email.toLowerCase() } as BotContext & {
    _customerEmail: string;
  };

  // The name is either already on the customer or was just collected (in context).
  const name = (context as { _customerName?: string })._customerName ?? customer?.name ?? 'there';
  return reply(
    MSG.chooseFulfillmentInteractive(name),
    'choosing_fulfillment',
    newContext,
  );
}

function handleChoosingFulfillment(text: string, context: BotContext): BotResponse {
  if (text === '1' || text === 'COLLECT' || text === 'COLLECTION') {
    const newContext: BotContext = {
      ...context,
      fulfillmentMethod: 'collection',
      deliveryZone: 'collection',
    };
    return buildOrderSummary(newContext);
  }

  if (text === '2' || text === 'DELIVER' || text === 'DELIVERY' || text === 'HARARE') {
    return reply(MSG.askDeliveryAddress(), 'collecting_address', {
      ...context,
      fulfillmentMethod: 'delivery',
      deliveryZone: 'harare_cbd',
    });
  }

  if (text === '3' || text === 'OUTSIDE') {
    return reply(MSG.outsideHarare(), 'collecting_address', {
      ...context,
      fulfillmentMethod: 'delivery',
      deliveryZone: 'outside_harare',
    });
  }

  const customerName =
    (context as BotContext & { _customerName?: string })._customerName ?? 'there';
  return {
    replies: [
      MSG.invalidFulfillmentChoice(),
      MSG.chooseFulfillmentInteractive(customerName),
    ],
    nextStep: 'choosing_fulfillment',
    nextContext: context,
    effects: [],
  };
}

function handleCollectingAddress(address: string, context: BotContext): BotResponse {
  if (!address || address.length < 5) {
    return reply(MSG.askDeliveryAddress(), 'collecting_address', context);
  }

  const newContext: BotContext = { ...context, deliveryAddress: address };
  return buildOrderSummary(newContext);
}

function buildOrderSummary(context: BotContext): BotResponse {
  const fulfillmentMethod = context.fulfillmentMethod ?? 'collection';
  const deliveryZone = context.deliveryZone ?? 'collection';

  const cartItems = context.cart.map((item) => ({
    sizeCode: item.sizeCode,
    quantity: item.quantity,
  }));

  const quoteResult = calculateQuote(cartItems, fulfillmentMethod, deliveryZone);

  if (!quoteResult.ok) {
    return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  }

  return reply(
    MSG.confirmOrderInteractive(quoteResult.quote.summary),
    'confirming_order',
    context,
  );
}

function handleConfirmingOrder(text: string, context: BotContext): BotResponse {
  if (text === 'PAY' || text === 'YES' || text === 'CONFIRM') {
    const fulfillmentMethod = context.fulfillmentMethod ?? 'collection';
    const deliveryZone = context.deliveryZone ?? 'collection';
    const cartItems = context.cart.map((item) => ({
      sizeCode: item.sizeCode,
      quantity: item.quantity,
    }));
    const quoteResult = calculateQuote(cartItems, fulfillmentMethod, deliveryZone);

    return {
      replies: [`⏳ Creating your order...`],
      nextStep: 'choosing_payment_method',
      nextContext: context,
      effects: quoteResult.ok
        ? [{ type: 'CREATE_ORDER', quote: quoteResult }]
        : [],
    };
  }

  if (text === 'CANCEL') {
    return {
      replies: [MSG.orderCancelled()],
      nextStep: 'idle',
      nextContext: emptyContext(),
      effects: [],
    };
  }

  // Re-show the summary
  return buildOrderSummary(context);
}

function handleChoosingPaymentMethod(text: string, context: BotContext): BotResponse {
  if (text === 'PAY_ECOCASH' || text === 'ECOCASH' || text === '1') {
    return reply(MSG.askEcocashNumber(), 'entering_ecocash_number', {
      ...context,
      paymentMethod: 'ecocash',
    });
  }

  if (text === 'PAY_CARD' || text === 'CARD') {
    // Card payments aren't built yet — keep them on EcoCash, no dead link.
    return reply(MSG.cardUnavailable(), 'choosing_payment_method', context);
  }

  if (text === 'CANCEL') {
    return {
      replies: [MSG.orderCancelled()],
      nextStep: 'idle',
      nextContext: emptyContext(),
      effects: [{ type: 'CANCEL_ORDER', orderNumber: context.orderNumber }],
    };
  }

  // Re-show the choice
  return reply(
    MSG.choosePaymentMethod(context.orderNumber ?? '', '0.00'),
    'choosing_payment_method',
    context,
  );
}

function handleEnteringEcocashNumber(text: string, context: BotContext): BotResponse {
  // Try to parse the input as an EcoCash number
  const result = isEcocashCapable(text);

  if (!result.ok) {
    if (result.reason === 'wrong_network') {
      return reply(MSG.ecocashWrongNetwork(), 'entering_ecocash_number', context);
    }
    return reply(MSG.ecocashInvalidFormat(), 'entering_ecocash_number', context);
  }

  // Number is valid EcoNet — initiate the EcoCash payment
  if (!context.orderNumber) {
    return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  }

  return {
    replies: [MSG.ecocashWaiting(result.number)],
    nextStep: 'awaiting_ecocash_pin',
    nextContext: { ...context, ecocashNumber: result.number },
    effects: [
      {
        type: 'INITIATE_ECOCASH_PAYMENT',
        orderNumber: context.orderNumber,
        ecocashNumber: result.number,
      },
    ],
  };
}

function handleAwaitingEcocashPin(text: string, context: BotContext): BotResponse {
  // Customer responded to timeout prompt
  if (text === '1') {
    // Try EcoCash again with same number
    if (!context.orderNumber || !context.ecocashNumber) {
      return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
    }
    return {
      replies: [MSG.ecocashWaiting(context.ecocashNumber)],
      nextStep: 'awaiting_ecocash_pin',
      nextContext: context,
      effects: [
        {
          type: 'INITIATE_ECOCASH_PAYMENT',
          orderNumber: context.orderNumber,
          ecocashNumber: context.ecocashNumber,
        },
      ],
    };
  }

  if (text === '2' || text === 'CANCEL') {
    return {
      replies: [MSG.orderCancelled()],
      nextStep: 'idle',
      nextContext: emptyContext(),
      effects: [{ type: 'CANCEL_ORDER', orderNumber: context.orderNumber }],
    };
  }

  // Customer typed something else while waiting — ack
  return reply(
    `⏳ Still waiting for your EcoCash PIN...\n\nIf the prompt didn't arrive, you can:\n1. Try again\n2. Cancel`,
    'awaiting_ecocash_pin',
    context,
  );
}

function handleAwaitingPayment(text: string, context: BotContext): BotResponse {
  if (text === 'RETRY' && context.orderNumber) {
    return {
      replies: [`⏳ Generating a new payment link...`],
      nextStep: 'awaiting_payment',
      nextContext: context,
      effects: [{ type: 'INITIATE_PAYMENT', orderNumber: context.orderNumber }],
    };
  }

  // Customer is just messaging while waiting — acknowledge
  return reply(
    `Your payment link was sent above. Complete the payment there and I'll confirm automatically.\n\nReply *CANCEL* to cancel the order.`,
    'awaiting_payment',
    context,
  );
}

// ===== Helpers =====

function reply(message: BotReply, nextStep: BotStep, nextContext: BotContext): BotResponse {
  return {
    replies: [message],
    nextStep,
    nextContext,
    effects: [],
  };
}
