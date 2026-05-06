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

import { eq, and, like, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, printJobs, printers, images, slipJobs, customers } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { calculateQuote } from '@/services/pricing.js';
import { getProduct } from '@/config/catalog.js';
import {
  renderOrderInfoSlip,
  renderEndSeparatorSlip,
  generateEnvelopeLabelZpl,
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

      // Create order items and print jobs
      for (const pricedItem of quote.items) {
        // Find the matching cart item for the image ref
        const cartItem = context.cart.find((c) => c.sizeCode === pricedItem.sizeCode);
        const imageRef = cartItem?.imageRef;

        // The imageRef IS the image UUID from the database (set by image-storage.storeImage)
        // It looks like 'pending' only if we never received an image (shouldn't happen in real flow)
        const imageId = imageRef && imageRef !== 'pending' ? imageRef : null;

        // Create the order item
        const [orderItem] = await tx
          .insert(orderItems)
          .values({
            orderId: order.id,
            imageId: imageId as unknown as string,
            productType: pricedItem.productType as 'photo_print' | 'poster',
            sizeCode: pricedItem.sizeCode,
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

  // Build the items list with display labels from catalog
  const slipItems = items.map((item) => {
    const product = getProduct(item.sizeCode);
    return {
      quantity: item.quantity,
      sizeLabel: product?.labelInches ?? item.sizeCode,
    };
  });

  const customerName = customer.name ?? 'Customer';
  const orderedAt = order.createdAt;

  // ===== Slip 1: end_separator (sequence 0, prints first) =====
  try {
    const url = await renderEndSeparatorSlip(orderNumber);
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
      customerPhone: customer.phoneNumber,
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

  // ===== Slip 3: envelope_label (thermal, no PNG, just ZPL) =====
  try {
    const labelData: EnvelopeLabelData = {
      orderNumber,
      customerName,
      customerPhone: customer.phoneNumber,
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
 * Send the customer a WhatsApp message that their order is ready for pickup.
 */
async function sendReadyForPickupNotification(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) return;

  const customer = await db
    .select()
    .from(customers)
    .where(eq(customers.id, order.customerId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!customer) return;

  // Lazy-import to avoid pulling whatsapp into modules that don't need it
  const { sendWhatsAppMessage } = await import('@/services/whatsapp.js');
  const { env } = await import('@/config/env.js');

  const lastName = customer.name?.split(/\s+/).pop() ?? customer.name ?? 'Customer';

  const message = `✅ Your order is ready!\n\nOrder: *${orderNumber}*\nName: *${lastName}*\n\nPick up at *FusionPrints HRE* during business hours (${env.BUSINESS_HOURS}).\n\nAt the counter, just give your last name or order number.\n\n📍 ${env.BUSINESS_ADDRESS}`;

  await sendWhatsAppMessage(customer.phoneNumber, message);
  logger.info({ orderNumber, phone: customer.phoneNumber }, 'Sent ready-for-pickup notification');
}

/**
 * Legacy: Mark an order as ready for collection.
 * Pre-Phase D status flow used 'ready_for_collection' directly.
 * New code should use releaseOrderForPickup() instead.
 * Kept for backward compat with existing admin dashboard code.
 */
export async function markOrderReady(orderNumber: string): Promise<void> {
  await db
    .update(orders)
    .set({
      status: 'ready_for_collection',
      readyAt: new Date(),
    })
    .where(eq(orders.orderNumber, orderNumber));

  logger.info({ orderNumber }, 'Order marked ready (legacy)');
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
