/**
 * Order service.
 *
 * Handles creating orders in the database when a customer confirms
 * and pays. This is the bridge between the bot's cart (in memory/context)
 * and the persistent order record.
 *
 * Order number format: FP-YYYY-NNNN (e.g. FP-2026-0042)
 * Resets sequence each year.
 */

import { eq, and, like, desc, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, printJobs, printers, slipJobs, customers, webUsers, promoCampaigns } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { env } from '@/config/env.js';
import { normalizePhone } from '@/utils/phone.js';
import { calculateQuote } from '@/services/pricing.js';
import { getProduct } from '@/config/catalog.js';
import {
  renderOrderInfoSlip,
  renderEndSeparatorSlip,
  generateEnvelopeLabelZpl,
  extractFirstName,
  type OrderInfoSlipData,
  type EnvelopeLabelData,
} from '@/services/slip-renderer.js';
import type { BotContext } from '@/bot/types.js';
import type { Order } from '@/db/schema.js';

/**
 * Generate the next order number in the sequence.
 * Format: FP-YYYY-NNNN
 */
async function generateOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `FP-${year}-`;

  // Find the highest order number for this year
  const existing = await db
    .select({ orderNumber: orders.orderNumber })
    .from(orders)
    .where(like(orders.orderNumber, `${prefix}%`))
    .orderBy(desc(orders.orderNumber))
    .limit(1);

  if (existing.length === 0) {
    return `${prefix}0001`;
  }

  const lastNumber = parseInt(existing[0].orderNumber.replace(prefix, ''), 10);
  const nextNumber = String(lastNumber + 1).padStart(4, '0');
  return `${prefix}${nextNumber}`;
}

export interface CreateOrderInput {
  customerId: string;
  context: BotContext;
}

export interface CreateOrderResult {
  ok: true;
  order: Order;
  orderNumber: string;
}

export interface CreateOrderError {
  ok: false;
  reason: string;
}

/**
 * Create an order in the database from the customer's confirmed cart.
 *
 * This is called after the customer types PAY and before the payment
 * link is generated. The order starts in 'pending_payment' status.
 *
 * Steps:
 *   1. Calculate the final quote (re-validates everything)
 *   2. Generate an order number
 *   3. Insert the order record
 *   4. Insert order_items (one per cart item)
 *   5. Insert print_jobs (one per order item, starts as 'queued' or 'awaiting_approval')
 *
 * Everything runs in a single transaction — if any step fails,
 * nothing is committed.
 */
export async function createOrder(
  input: CreateOrderInput,
): Promise<CreateOrderResult | CreateOrderError> {
  const { customerId, context } = input;

  // Validate the cart has items
  if (!context.cart || context.cart.length === 0) {
    return { ok: false, reason: 'Cart is empty' };
  }

  const fulfillmentMethod = context.fulfillmentMethod ?? 'collection';
  const deliveryZone = context.deliveryZone ?? 'collection';

  // Re-calculate the quote to ensure pricing is current
  const cartItems = context.cart.map((item) => ({
    sizeCode: item.sizeCode,
    quantity: item.quantity,
  }));

  const quoteResult = calculateQuote(cartItems, fulfillmentMethod, deliveryZone);

  if (!quoteResult.ok) {
    logger.error({ reason: quoteResult.error }, 'Quote calculation failed during order creation');
    return { ok: false, reason: quoteResult.error.message };
  }

  const quote = quoteResult.quote;

  try {
    // Run everything in a transaction
    const result = await db.transaction(async (tx) => {
      const orderNumber = await generateOrderNumber();

      // Create the order
      const [order] = await tx
        .insert(orders)
        .values({
          customerId,
          orderNumber,
          status: 'pending_payment',
          subtotalUsd: String(quote.subtotalUsd),
          deliveryFeeUsd: String(quote.deliveryFeeUsd),
          totalUsd: String(quote.totalUsd),
          fulfillmentMethod,
          deliveryAddress: context.deliveryAddress ?? null,
        })
        .returning();

      // Find the printers for job assignment
      const allPrinters = await tx.select().from(printers);
      const dnpPrinter = allPrinters.find((p) => p.printerType === 'dye_sub');
      const epsonPrinter = allPrinters.find((p) => p.printerType === 'inkjet');

      // Create order items and print jobs. quote.items is index-aligned with
      // context.cart (calculateQuote prices each cart item in order, no
      // aggregation), so match by index — this is correct even when two items
      // share a sizeCode (e.g. two different wallet sets) where find-by-sizeCode
      // would collapse them onto the same photo.
      for (let i = 0; i < quote.items.length; i++) {
        const pricedItem = quote.items[i];
        const cartItem = context.cart[i];
        const imageRef = cartItem?.imageRef;

        // The imageRef IS the image UUID from the database (set by image-storage.storeImage)
        // It looks like 'pending' only if we never received an image (shouldn't happen in real flow)
        const imageId = imageRef && imageRef !== 'pending' ? imageRef : null;

        // Composite products: store which image fills which cell. transform/border
        // are null for WhatsApp orders (defaults); the web editor sets them.
        const layoutPayload = cartItem?.compositeCells
          ? {
              cells: cartItem.compositeCells.map((c) => ({
                cellIndex: c.cellIndex,
                imageId: c.imageRef && c.imageRef !== 'pending' ? c.imageRef : null,
                transform: null,
                border: null,
              })),
            }
          : null;

        // Create the order item
        const [orderItem] = await tx
          .insert(orderItems)
          .values({
            orderId: order.id,
            imageId: imageId as unknown as string,
            productType: pricedItem.productType as 'photo_print' | 'poster' | 'composite',
            sizeCode: pricedItem.sizeCode,
            layoutPayload,
            quantity: pricedItem.quantity,
            unitPriceUsd: String(pricedItem.unitPriceUsd),
            lineTotalUsd: String(pricedItem.lineTotalUsd),
            requiresManualReview: pricedItem.requiresManualReview,
          })
          .returning();

        // Determine which printer handles this item
        const product = getProduct(pricedItem.sizeCode);
        const isLargeFormat = ['8x10', '11x14', '12x18', '16x20'].includes(
          pricedItem.sizeCode,
        );
        const assignedPrinter = isLargeFormat ? epsonPrinter : dnpPrinter;

        // Phase D.1: tag the print job with its target printer type for routing
        const targetPrinterType = product
          ? (product.printer === 'dnp_ds620a_4x6' ? 'dye_sub_4x6' as const
            : product.printer === 'dnp_ds620a_5x7' ? 'dye_sub_5x7' as const
            : 'inkjet' as const)
          : null;

        // Create the print job
        const jobStatus = pricedItem.requiresManualReview ? 'awaiting_approval' : 'queued';

        await tx.insert(printJobs).values({
          orderItemId: orderItem.id,
          printerId: assignedPrinter?.id ?? null,
          targetPrinterType,
          status: jobStatus,
        });
      }

      logger.info(
        { orderNumber, customerId, total: quote.totalUsd },
        'Order created successfully',
      );

      return { order, orderNumber };
    });

    return { ok: true, order: result.order, orderNumber: result.orderNumber };
  } catch (err) {
    logger.error({ err, customerId }, 'Failed to create order');
    return { ok: false, reason: 'Database error creating order' };
  }
}

// ===== Web (self-serve) order creation =====

export interface CreateWebOrderItem {
  /** Standard prints: the editor's print-ready render. Absent for composites. */
  processedImageId?: string | null;
  /** The original source image, when known (order_items.imageId). */
  sourceImageId?: string | null;
  sizeCode: string;
  quantity: number;
  /** Finish chosen on web: 'glossy' | 'satin'. */
  paper?: string | null;
  /** Composite products (wallet/passport/mini). */
  productType?: 'composite';
  /** Composite cell→image mapping (+ transforms/borders) → order_items.layout_payload. */
  layoutPayload?: unknown;
}

export interface CreateWebOrderInput {
  webUserId: string;
  items: CreateWebOrderItem[];
  fulfillmentMethod?: 'collection' | 'delivery';
  /** Delivery zone for the fee calc; 'collection' when picking up. */
  deliveryZone?: string;
  deliveryAddress?: string | null;
  /** Contact phone captured at checkout (required for web orders). */
  contactPhone?: string | null;
  notes?: string | null;
}

/**
 * Create a web order from a signed-in user's cart. Mirrors createOrder() but
 * keyed on webUserId (channel = 'web', no WhatsApp customer) and links each line
 * to its edited render via processedImageId. Starts in 'pending_payment'.
 *
 * Pricing/printer-routing reuse the shared services so web and WhatsApp orders
 * price and route identically. quote.items is 1:1 (and in order) with the input
 * items, so we map them back by index — this preserves multiple photos that
 * share the same size code (which the WhatsApp size-match path can't).
 */
export async function createWebOrder(
  input: CreateWebOrderInput,
): Promise<CreateOrderResult | CreateOrderError> {
  const { webUserId, items, deliveryAddress, contactPhone, notes } = input;

  if (!items || items.length === 0) {
    return { ok: false, reason: 'Cart is empty' };
  }

  const fulfillmentMethod = input.fulfillmentMethod ?? 'collection';
  const deliveryZone = input.deliveryZone ?? 'collection';

  const cartItems = items.map((i) => ({ sizeCode: i.sizeCode, quantity: i.quantity }));
  const quoteResult = calculateQuote(cartItems, fulfillmentMethod, deliveryZone);

  if (!quoteResult.ok) {
    logger.error({ reason: quoteResult.error }, 'Quote calculation failed during web order creation');
    return { ok: false, reason: quoteResult.error.message };
  }

  const quote = quoteResult.quote;

  try {
    const result = await db.transaction(async (tx) => {
      const orderNumber = await generateOrderNumber();

      const [order] = await tx
        .insert(orders)
        .values({
          webUserId,
          channel: 'web',
          orderNumber,
          status: 'pending_payment',
          subtotalUsd: String(quote.subtotalUsd),
          deliveryFeeUsd: String(quote.deliveryFeeUsd),
          totalUsd: String(quote.totalUsd),
          fulfillmentMethod,
          deliveryAddress: deliveryAddress ?? null,
          contactPhone: contactPhone ?? null,
          notes: notes ?? null,
        })
        .returning();

      // Web orders insert only the line items here. Print jobs are NOT created
      // until payment is confirmed (see enqueueWebPrintJobs in markOrderPaid),
      // so the print agent can never pick up an unpaid web order.
      for (let i = 0; i < quote.items.length; i++) {
        const priced = quote.items[i];
        const src = items[i];

        await tx.insert(orderItems).values({
          orderId: order.id,
          imageId: src.sourceImageId ?? null,
          processedImageId: src.processedImageId ?? null,
          productType: priced.productType as 'photo_print' | 'poster' | 'composite',
          sizeCode: priced.sizeCode,
          paper: src.paper ?? null,
          layoutPayload: src.layoutPayload ?? null,
          quantity: priced.quantity,
          unitPriceUsd: String(priced.unitPriceUsd),
          lineTotalUsd: String(priced.lineTotalUsd),
          requiresManualReview: priced.requiresManualReview,
        });
      }

      logger.info({ orderNumber, webUserId, total: quote.totalUsd }, 'Web order created (pending payment)');
      return { order, orderNumber };
    });

    return { ok: true, order: result.order, orderNumber: result.orderNumber };
  } catch (err) {
    logger.error({ err, webUserId }, 'Failed to create web order');
    return { ok: false, reason: 'Database error creating order' };
  }
}

/**
 * Create print jobs for every item in an order, with the same printer routing
 * as the WhatsApp flow. Called once a web order's payment is confirmed. Safe to
 * skip if jobs already exist (idempotent guard against double webhooks).
 */
export async function enqueueWebPrintJobs(orderId: string): Promise<void> {
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  if (items.length === 0) return;

  const existing = await db
    .select({ id: printJobs.id })
    .from(printJobs)
    .where(inArray(printJobs.orderItemId, items.map((i) => i.id)));
  if (existing.length > 0) return; // already enqueued

  const allPrinters = await db.select().from(printers);
  const dnpPrinter = allPrinters.find((p) => p.printerType === 'dye_sub');
  const epsonPrinter = allPrinters.find((p) => p.printerType === 'inkjet');

  for (const item of items) {
    const product = getProduct(item.sizeCode);
    const isLargeFormat = ['8x10', '11x14', '12x18', '16x20'].includes(item.sizeCode);
    const assignedPrinter = isLargeFormat ? epsonPrinter : dnpPrinter;
    const targetPrinterType = product
      ? (product.printer === 'dnp_ds620a_4x6' ? 'dye_sub_4x6' as const
        : product.printer === 'dnp_ds620a_5x7' ? 'dye_sub_5x7' as const
        : 'inkjet' as const)
      : null;
    const jobStatus = item.requiresManualReview ? 'awaiting_approval' : 'queued';

    await db.insert(printJobs).values({
      orderItemId: item.id,
      printerId: assignedPrinter?.id ?? null,
      targetPrinterType,
      status: jobStatus,
    });
  }
  logger.info({ orderId, jobs: items.length }, 'Enqueued web print jobs after payment');
}

/** Recent orders for a web user (newest first). Used by the web order history. */
export async function getWebUserOrders(webUserId: string, limit = 20): Promise<Order[]> {
  return db
    .select()
    .from(orders)
    .where(eq(orders.webUserId, webUserId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

/** A single web order by number, scoped to its owner (ownership check). */
export async function getWebOrderByNumber(
  webUserId: string,
  orderNumber: string,
): Promise<Order | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.orderNumber, orderNumber), eq(orders.webUserId, webUserId)))
    .limit(1);
  return order ?? null;
}

/**
 * Mark an order as paid.
 * Called when the payment webhook confirms successful payment.
 *
 * Phase D.2: also queues 3 slip jobs for the order:
 *   - end_separator (sequence 0, prints first → bottom of stack)
 *   - order_info    (sequence 100, prints last → top of stack)
 *   - envelope_label (thermal, no sequence concern)
 *
 * Slip rendering is wrapped in try/catch — a failed slip does NOT
 * block the order or customer prints. The operator can manually
 * reprint a failed slip later from the admin dashboard.
 */
export async function markOrderPaid(
  orderNumber: string,
  paymentReference: string,
): Promise<void> {
  await db
    .update(orders)
    .set({
      status: 'paid',
      paidAt: new Date(),
    })
    .where(eq(orders.orderNumber, orderNumber));

  logger.info({ orderNumber, paymentReference }, 'Order marked as paid');

  // Web orders create their print jobs now (not at order time), so an unpaid
  // web order is never dispatchable. WhatsApp orders already have their jobs.
  try {
    const paidOrder = await getOrderByNumber(orderNumber);
    if (paidOrder?.channel === 'web') {
      await enqueueWebPrintJobs(paidOrder.id);
    }
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to enqueue web print jobs after payment');
  }

  // Queue slips alongside customer prints.
  // Errors here are logged but do NOT throw — order remains paid even if slip rendering fails.
  try {
    await queueOrderSlips(orderNumber, paymentReference);
  } catch (err) {
    logger.error(
      { orderNumber, err },
      'Failed to queue slips — order is paid, slips will need manual recovery',
    );
  }
}

/**
 * Queue the 3 slip jobs for an order.
 * Renders each slip and inserts a slip_jobs row.
 *
 * Failed slips are logged and skipped — they do not block the others.
 */
async function queueOrderSlips(orderNumber: string, paymentMethod: string): Promise<void> {
  // Load order + items + customer for slip data
  const order = await getOrderByNumber(orderNumber);
  if (!order) {
    logger.warn({ orderNumber }, 'Cannot queue slips — order not found');
    return;
  }

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  if (items.length === 0) {
    logger.warn({ orderNumber }, 'Cannot queue slips — order has no items');
    return;
  }

  // Resolve the recipient from either the WhatsApp customer or the web user.
  let customerName = 'Customer';
  let customerPhone = '';
  if (order.customerId) {
    const customer = await db
      .select()
      .from(customers)
      .where(eq(customers.id, order.customerId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!customer) {
      logger.warn({ orderNumber }, 'Cannot queue slips — customer not found');
      return;
    }
    customerName = customer.name ?? 'Customer';
    customerPhone = customer.phoneNumber;
  } else if (order.webUserId) {
    const webUser = await db
      .select()
      .from(webUsers)
      .where(eq(webUsers.id, order.webUserId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!webUser) {
      logger.warn({ orderNumber }, 'Cannot queue slips — web user not found');
      return;
    }
    customerName = webUser.displayName ?? webUser.email;
    customerPhone = webUser.whatsappNumber ?? '';
  } else {
    logger.warn({ orderNumber }, 'Cannot queue slips — no recipient on order');
    return;
  }

  // Build the items list with display labels from catalog
  const slipItems = items.map((item) => {
    const product = getProduct(item.sizeCode);
    return {
      quantity: item.quantity,
      sizeLabel: product?.labelInches ?? item.sizeCode,
    };
  });

  const orderedAt = order.createdAt;

  // ===== Slip 1: end_separator (sequence 0, prints first) =====
  try {
    const url = await renderEndSeparatorSlip(orderNumber, extractFirstName(customerName));
    await db.insert(slipJobs).values({
      orderId: order.id,
      slipType: 'end_separator',
      targetPrinterType: 'dye_sub_4x6',
      sequencePosition: 0,
      printReadyFileUrl: url,
      status: 'queued',
    });
    logger.info({ orderNumber }, 'Queued end_separator slip');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to queue end_separator slip');
  }

  // ===== Slip 2: order_info (sequence 100, prints last) =====
  try {
    const orderInfoData: OrderInfoSlipData = {
      orderNumber,
      customerName,
      customerPhone,
      paymentMethod,
      fulfillmentMethod: order.fulfillmentMethod,
      items: slipItems,
      orderedAt,
    };
    const url = await renderOrderInfoSlip(orderInfoData);
    await db.insert(slipJobs).values({
      orderId: order.id,
      slipType: 'order_info',
      targetPrinterType: 'dye_sub_4x6',
      sequencePosition: 100,
      printReadyFileUrl: url,
      status: 'queued',
    });
    logger.info({ orderNumber }, 'Queued order_info slip');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to queue order_info slip');
  }

  // ===== Promo slips (sequence 60 & 70): static campaign cards =====
  // Both promo cards are static per campaign (pre-rendered PNGs in B2), so we
  // just point the slip at the active campaign's image — no per-order render.
  // They sit between customer prints (50) and order_info (100), so they land on
  // top of the customer's prints and below the order-info card.
  try {
    const [campaign] = await db
      .select()
      .from(promoCampaigns)
      .where(eq(promoCampaigns.active, true))
      .limit(1);
    if (campaign) {
      const slots = [
        { slot: campaign.slot1, seq: 60 },
        { slot: campaign.slot2, seq: 70 },
      ];
      for (const { slot, seq } of slots) {
        if (!slot?.imageKey) continue; // a slot with no rendered card is skipped
        const url = `https://${env.B2_BUCKET_NAME}.${env.B2_ENDPOINT}/${slot.imageKey}`;
        await db.insert(slipJobs).values({
          orderId: order.id,
          slipType: 'promo',
          targetPrinterType: 'dye_sub_4x6',
          sequencePosition: seq,
          printReadyFileUrl: url,
          campaignId: campaign.id,
          status: 'queued',
        });
      }
      logger.info({ orderNumber, campaign: campaign.name }, 'Queued promo slips');
    } else {
      logger.info({ orderNumber }, 'No active promo campaign — skipping promo slips');
    }
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to queue promo slips');
  }

  // ===== Slip 3: envelope_label (thermal, no PNG, just ZPL) =====
  try {
    const labelData: EnvelopeLabelData = {
      orderNumber,
      customerName,
      customerPhone,
      paymentMethod,
      fulfillmentMethod: order.fulfillmentMethod,
      items: slipItems,
      orderedAt,
    };
    const zpl = generateEnvelopeLabelZpl(labelData);
    await db.insert(slipJobs).values({
      orderId: order.id,
      slipType: 'envelope_label',
      targetPrinterType: 'thermal_label',
      sequencePosition: 0,
      payloadJson: { zpl },
      status: 'queued',
    });
    logger.info({ orderNumber }, 'Queued envelope_label slip');
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to queue envelope_label slip');
  }
}

/**
 * Release an order for customer pickup.
 * Called from the admin dashboard "Release for Pickup" button after the
 * operator has physically collected all prints from printer trays and
 * placed them in the pickup envelope with the label applied.
 *
 * Phase D.3: also sends the customer a WhatsApp notification.
 */
export async function releaseOrderForPickup(orderNumber: string): Promise<void> {
  await db
    .update(orders)
    .set({
      status: 'ready_for_pickup',
      readyAt: new Date(),
    })
    .where(eq(orders.orderNumber, orderNumber));

  logger.info({ orderNumber }, 'Order released for pickup');

  // Send customer notification (best effort — failure does not roll back the status)
  try {
    await sendReadyForPickupNotification(orderNumber);
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to send ready-for-pickup notification');
  }
}

/**
 * Resolve the customer's name + a WhatsApp-deliverable phone number for an order,
 * regardless of channel:
 *   WhatsApp orders → the customer record (already a valid msisdn).
 *   Web orders      → the checkout contact phone (falling back to the profile
 *                     WhatsApp number), NORMALISED to +263XXXXXXXXX — web
 *                     customers type "0771…" / "771…" which 360dialog rejects
 *                     raw, so without this the send silently fails.
 * Returns null when no usable number is found (caller logs + skips).
 */
async function resolveOrderContact(
  order: Order,
): Promise<{ name: string; phone: string } | null> {
  let name = 'Customer';
  let phone = '';
  if (order.customerId) {
    const customer = await db
      .select()
      .from(customers)
      .where(eq(customers.id, order.customerId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!customer) return null;
    name = customer.name ?? 'Customer';
    phone = customer.phoneNumber;
  } else if (order.webUserId) {
    const webUser = await db
      .select()
      .from(webUsers)
      .where(eq(webUsers.id, order.webUserId))
      .limit(1)
      .then((rows) => rows[0]);
    name = webUser?.displayName ?? webUser?.email ?? 'Customer';
    const raw = order.contactPhone ?? webUser?.whatsappNumber ?? '';
    // Normalise to E.164 for any country (default Zimbabwe for bare locals);
    // keep the raw value if it somehow doesn't parse so we never regress a
    // number 360dialog might still accept.
    phone = raw ? normalizePhone(raw) ?? raw : '';
  }

  if (!phone) {
    logger.warn({ orderNumber: order.orderNumber }, 'No usable phone on order — skipping notification');
    return null;
  }
  return { name, phone };
}

/**
 * Send the customer a WhatsApp message that their order is ready for pickup.
 */
async function sendReadyForPickupNotification(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) return;

  const contact = await resolveOrderContact(order);
  if (!contact) return;

  // Lazy-import to avoid pulling whatsapp into modules that don't need it
  const { sendWhatsAppMessage } = await import('@/services/whatsapp.js');
  const { env } = await import('@/config/env.js');

  const lastName = contact.name.split(/\s+/).pop() ?? contact.name;

  const message = `✅ Your order is ready!\n\nOrder: *${orderNumber}*\nName: *${lastName}*\n\nPick up at *FusionPrints HRE* during business hours (${env.BUSINESS_HOURS}).\n\nAt the counter, just give your last name or order number.\n\n📍 ${env.BUSINESS_ADDRESS}`;

  await sendWhatsAppMessage(contact.phone, message);
  logger.info({ orderNumber, phone: contact.phone }, 'Sent ready-for-pickup notification');
}

/**
 * Mark a delivery order as shipped/out for delivery and notify the customer.
 * Used by the admin "Mark out for delivery" action. The status update always
 * lands; the notification is best-effort (failure does not roll it back).
 */
export async function markOrderShipped(orderId: string): Promise<void> {
  await db
    .update(orders)
    .set({ status: 'shipped', shippedAt: new Date() })
    .where(eq(orders.id, orderId));

  const order = await db
    .select({ orderNumber: orders.orderNumber })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)
    .then((rows) => rows[0]);

  logger.info({ orderId, orderNumber: order?.orderNumber }, 'Order marked shipped');

  if (!order?.orderNumber) return;
  try {
    await sendOutForDeliveryNotification(order.orderNumber);
  } catch (err) {
    logger.error({ orderId, err }, 'Failed to send out-for-delivery notification');
  }
}

/**
 * Send the customer a WhatsApp message that their delivery order is on its way.
 */
async function sendOutForDeliveryNotification(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) return;

  const contact = await resolveOrderContact(order);
  if (!contact) return;

  const { sendWhatsAppMessage } = await import('@/services/whatsapp.js');

  const lastName = contact.name.split(/\s+/).pop() ?? contact.name;

  const message = `🚚 Your order is on its way!\n\nOrder: *${orderNumber}*\nName: *${lastName}*\n\nYour prints have left *FusionPrints HRE* and are out for delivery. Our driver will be in touch shortly.\n\nQuestions? Just reply to this message.`;

  await sendWhatsAppMessage(contact.phone, message);
  logger.info({ orderNumber, phone: contact.phone }, 'Sent out-for-delivery notification');
}

/**
 * Cancel an order.
 * Called when customer types CANCEL or payment times out.
 */
export async function cancelOrder(orderNumber: string): Promise<void> {
  await db
    .update(orders)
    .set({ status: 'cancelled' })
    .where(eq(orders.orderNumber, orderNumber));

  logger.info({ orderNumber }, 'Order cancelled');
}

/**
 * Get recent orders for a customer (last 5).
 * Used for the "check my order status" flow.
 */
export async function getRecentOrders(customerId: string): Promise<Order[]> {
  return db
    .select()
    .from(orders)
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.createdAt))
    .limit(5);
}

/**
 * Look up a single order by its public order number (e.g. "FP-2026-0042").
 * Returns null if not found.
 */
export async function getOrderByNumber(orderNumber: string): Promise<Order | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);
  return order ?? null;
}
