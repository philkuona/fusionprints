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
import { orders, orderItems, printJobs, printers, images } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { calculateQuote } from '@/services/pricing.js';
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
        const isLargeFormat = ['8x10', '11x14', '12x18', '16x20', '18x24', '24x36'].includes(
          pricedItem.sizeCode,
        );
        const assignedPrinter = isLargeFormat ? epsonPrinter : dnpPrinter;

        // Create the print job
        const jobStatus = pricedItem.requiresManualReview ? 'awaiting_approval' : 'queued';

        await tx.insert(printJobs).values({
          orderItemId: orderItem.id,
          printerId: assignedPrinter?.id ?? null,
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
}

/**
 * Mark an order as ready for collection or out for delivery.
 * Called from the admin dashboard.
 */
export async function markOrderReady(orderNumber: string): Promise<void> {
  await db
    .update(orders)
    .set({
      status: 'ready_for_collection',
      readyAt: new Date(),
    })
    .where(eq(orders.orderNumber, orderNumber));

  logger.info({ orderNumber }, 'Order marked ready');
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
