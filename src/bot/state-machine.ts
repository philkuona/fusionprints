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
import { MSG } from './messages.js';
import type { BotStep, BotContext, CartItem, FulfillmentMethod } from './types.js';
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

export interface BotResponse {
  /** Messages to send back to the customer, in order */
  replies: string[];
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
  | { type: 'CANCEL_ORDER'; orderNumber: string }
  | { type: 'LOOKUP_ORDER_STATUS'; phone: string };

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
  customer: { name: string | null } | null,
): BotResponse {
  const text = message.text.trim().toUpperCase();

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

    case 'collecting_image_batch':
      return handleCollectingImageBatch(text, message, context);

    case 'choosing_quantity':
      return handleChoosingQuantity(text, context);

    case 'adding_more_or_checkout':
      return handleAddMoreOrCheckout(text, context, customer);

    case 'collecting_name':
      return handleCollectingName(text, context);

    case 'choosing_fulfillment':
      return handleChoosingFulfillment(text, context);

    case 'collecting_address':
      return handleCollectingAddress(message.text.trim(), context);

    case 'confirming_order':
      return handleConfirmingOrder(text, context);

    case 'awaiting_payment':
      return handleAwaitingPayment(text, context);

    default:
      return reply(MSG.somethingWentWrong(), 'idle', emptyContext());
  }
}

// ===== Step handlers =====

function handleIdle(
  context: BotContext,
  customer: { name: string | null } | null,
): BotResponse {
  return reply(MSG.greeting(customer?.name ?? undefined), 'choosing_product', emptyContext());
}

function handleChoosingProduct(
  text: string,
  context: BotContext,
  customer: { name: string | null } | null,
): BotResponse {
  // Accept shortcuts typed naturally
  if (text === '1' || text === 'PHOTOS' || text === 'PHOTO' || text === 'PHOTO PRINTS') {
    return reply(MSG.photoSizeMenu(), 'choosing_size', {
      ...context,
      pendingProductType: 'photo_print',
    });
  }

  if (text === '2' || text === 'POSTERS' || text === 'POSTER') {
    return reply(MSG.posterSizeMenu(), 'choosing_size', {
      ...context,
      pendingProductType: 'poster',
    });
  }

  if (text === '3' || text === 'STATUS' || text === 'ORDER') {
    return {
      replies: [MSG.noRecentOrders()],
      nextStep: 'choosing_product',
      nextContext: context,
      effects: [{ type: 'LOOKUP_ORDER_STATUS', phone: '' }],
    };
  }

  // They typed something else — re-show the greeting
  return reply(MSG.greeting(customer?.name ?? undefined), 'choosing_product', context);
}

function handleChoosingSize(text: string, context: BotContext): BotResponse {
  const products =
    context.pendingProductType === 'photo_print' ? PHOTO_PRODUCTS : POSTER_PRODUCTS;

  const choice = parseInt(text, 10);
  if (isNaN(choice) || choice < 1 || choice > products.length) {
    const menu =
      context.pendingProductType === 'photo_print'
        ? MSG.photoSizeMenu()
        : MSG.posterSizeMenu();
    return reply(
      `${MSG.invalidSizeChoice(products.length)}\n\n${menu}`,
      'choosing_size',
      context,
    );
  }

  const product = products[choice - 1];
  const priceLabel = `$${product.unitPriceUsd.toFixed(2)}`;

  return reply(
    MSG.chooseUploadMode(product.displayLabel, priceLabel),
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
    // Single image, multiple copies path (existing flow)
    return reply(MSG.awaitingImage(product.displayLabel, priceLabel), 'awaiting_image', {
      ...context,
      uploadMode: 'single',
    });
  }

  if (text === '2' || text === 'MULTIPLE' || text === 'MANY') {
    // Multiple images, one copy each path
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

  return reply(
    `${MSG.invalidUploadMode()}\n\n${MSG.chooseUploadMode(product.displayLabel, priceLabel)}`,
    'choosing_upload_mode',
    context,
  );
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

  return reply(MSG.itemAdded(newItem, cartTotalLabel), 'adding_more_or_checkout', newContext);
}

function handleAddMoreOrCheckout(
  text: string,
  context: BotContext,
  customer: { name: string | null } | null,
): BotResponse {
  if (text === '1' || text === 'ADD' || text === 'MORE' || text === 'ADD MORE') {
    return reply(MSG.greeting(customer?.name ?? undefined), 'choosing_product', context);
  }

  if (text === '2' || text === 'CHECKOUT' || text === 'DONE' || text === 'NEXT') {
    // If we don't have their name yet, ask for it
    if (!customer?.name) {
      return reply(MSG.askName(), 'collecting_name', context);
    }
    // Otherwise go straight to fulfillment
    return reply(
      MSG.chooseFulfillment(customer.name),
      'choosing_fulfillment',
      context,
    );
  }

  return reply(MSG.addMoreOrCheckout(), 'adding_more_or_checkout', context);
}

function handleCollectingName(text: string, context: BotContext): BotResponse {
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

  return reply(
    MSG.chooseFulfillment(formattedName),
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
  return reply(
    `${MSG.invalidFulfillmentChoice()}\n\n${MSG.chooseFulfillment(customerName)}`,
    'choosing_fulfillment',
    context,
  );
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
    MSG.confirmOrder(quoteResult.quote.summary),
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
      nextStep: 'awaiting_payment',
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

function reply(message: string, nextStep: BotStep, nextContext: BotContext): BotResponse {
  return {
    replies: [message],
    nextStep,
    nextContext,
    effects: [],
  };
}
