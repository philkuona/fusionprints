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

import { eq, and, like, desc, inArray, lt } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, printJobs, printers, slipJobs, customers, webUsers, promoCampaigns, payments, holidays } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { env } from '@/config/env.js';
import { nextWorkingDay } from '@/utils/working-days.js';
import { randomBytes } from 'crypto';
import { normalizePhone } from '@/utils/phone.js';
import { calculateQuote } from '@/services/pricing.js';
import { getOrderMinimums, getDnpMediaMode } from '@/services/store-settings.js';
import { getOrderCollectionPoint, pointHours } from '@/services/collection-points.js';
import { getProduct } from '@/config/catalog.js';
import { getProductCost } from '@/services/cost-overrides.js';
import { sendWhatsAppMessage, sendWhatsAppTemplate } from '@/services/whatsapp.js';
import { sendOrderReadyEmail, sendOrderFulfilledEmail } from '@/services/web-order-email.js';
import { MSG } from '@/bot/messages.js';
import { sendFiveBySevenOperatorEmail, sendApprovalNeededAlert, sendMediaSwitchAlert } from '@/services/operator-email.js';
import {
  isEnabled as qboEnabled,
  isSetupComplete,
  createSalesReceipt,
  findSalesReceiptId,
  createInvoice,
  recordInvoicePayment,
  voidInvoice,
  type OrderItemForQbo,
  type QboCustomerInfo,
} from '@/services/qbo.js';
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

// Crockford base32 alphabet (no I/L/O/U — unambiguous when read aloud/typed).
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate an opaque, non-sequential public order reference (audit IMP-14).
 * 10 chars of Crockford base32 ≈ 50 bits — not enumerable, unlike the
 * sequential order_number. Uniqueness is enforced by the column's unique index;
 * a collision at this scale is astronomically unlikely.
 */
function generatePublicRef(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += REF_ALPHABET[bytes[i] & 31];
  return out;
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

  const quoteResult = calculateQuote(cartItems, fulfillmentMethod, deliveryZone, await getOrderMinimums());

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
          publicRef: generatePublicRef(),
          status: 'pending_payment',
          subtotalUsd: String(quote.subtotalUsd),
          deliveryFeeUsd: String(quote.deliveryFeeUsd),
          totalUsd: String(quote.totalUsd),
          fulfillmentMethod,
          deliveryAddress: context.deliveryAddress ?? null,
          collectionPointId: context.selectedCollectionPointId ?? null,
          recipientPhone: context.recipientPhone ?? null,
        })
        .returning();

      // Create order items only. Print jobs are NOT created here — they're
      // enqueued at markOrderPaid (like web orders), so an unpaid order is never
      // dispatchable to a printer. quote.items is index-aligned with
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

        // Create the order item. Print jobs are enqueued later, at markOrderPaid.
        await tx
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
            unitCostUsd: getProductCost(pricedItem.sizeCode).toFixed(2),
            lineCostUsd: (getProductCost(pricedItem.sizeCode) * pricedItem.quantity).toFixed(2),
            requiresManualReview: pricedItem.requiresManualReview,
          });
      }

      logger.info(
        { orderNumber, customerId, total: quote.totalUsd },
        'Order created successfully',
      );

      return { order, orderNumber };
    });

    // NOTE: 5×7 next-working-day + operator alert is applied at markOrderPaid
    // (post-payment) for ALL channels — bot orders are created at
    // pending_payment here, so firing the operator alert now would be premature.

    // Open the QBO invoice now (AR). Best-effort + fire-and-forget — never block
    // order creation; voided automatically if the checkout is abandoned.
    void createQboInvoiceForOrder(result.order.id).catch((err) =>
      logger.error({ orderNumber: result.orderNumber, err }, 'QBO invoice creation failed'),
    );

    return { ok: true, order: result.order, orderNumber: result.orderNumber };
  } catch (err) {
    logger.error({ err, customerId }, 'Failed to create order');
    return { ok: false, reason: "Sorry, we couldn't create your order just now. Please try again." };
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
  /** Chosen pickup location (collection orders); null = primary point. */
  collectionPointId?: string | null;
  /** Contact phone captured at checkout (required for web orders). */
  contactPhone?: string | null;
  /** Full name captured at checkout (required for web orders) — for QBO. */
  contactName?: string | null;
  /** Gift recipient (R2-13): name + WhatsApp number to notify alongside buyer. */
  recipientName?: string | null;
  recipientPhone?: string | null;
  /** Billing address when it differs from delivery (R2-13 Stage 2). Free-text. */
  billingAddress?: string | null;
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
  const { webUserId, items, deliveryAddress, collectionPointId, contactPhone, contactName, recipientName, recipientPhone, billingAddress, notes } = input;

  if (!items || items.length === 0) {
    return { ok: false, reason: 'Cart is empty' };
  }

  const fulfillmentMethod = input.fulfillmentMethod ?? 'collection';
  const deliveryZone = input.deliveryZone ?? 'collection';

  const cartItems = items.map((i) => ({ sizeCode: i.sizeCode, quantity: i.quantity }));
  const quoteResult = calculateQuote(cartItems, fulfillmentMethod, deliveryZone, await getOrderMinimums());

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
          publicRef: generatePublicRef(),
          status: 'pending_payment',
          subtotalUsd: String(quote.subtotalUsd),
          deliveryFeeUsd: String(quote.deliveryFeeUsd),
          totalUsd: String(quote.totalUsd),
          fulfillmentMethod,
          deliveryAddress: deliveryAddress ?? null,
          collectionPointId: collectionPointId ?? null,
          contactPhone: contactPhone ?? null,
          contactName: contactName ?? null,
          recipientName: recipientName ?? null,
          recipientPhone: recipientPhone ?? null,
          billingAddress: billingAddress ?? null,
          notes: notes ?? null,
        })
        .returning();

      // Insert only the line items here. Print jobs are NOT created until payment
      // is confirmed (see enqueuePrintJobsForOrder in markOrderPaid), so the print
      // agent can never pick up an unpaid order.
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
          unitCostUsd: getProductCost(priced.sizeCode).toFixed(2),
          lineCostUsd: (getProductCost(priced.sizeCode) * priced.quantity).toFixed(2),
          requiresManualReview: priced.requiresManualReview,
        });
      }

      logger.info({ orderNumber, webUserId, total: quote.totalUsd }, 'Web order created (pending payment)');
      return { order, orderNumber };
    });

    // Open the QBO invoice now (AR). Best-effort + fire-and-forget — never block
    // order creation; voided automatically if the checkout is abandoned.
    void createQboInvoiceForOrder(result.order.id).catch((err) =>
      logger.error({ orderNumber: result.orderNumber, err }, 'QBO invoice creation failed'),
    );

    return { ok: true, order: result.order, orderNumber: result.orderNumber };
  } catch (err) {
    logger.error({ err, webUserId }, 'Failed to create web order');
    return { ok: false, reason: "Sorry, we couldn't create your order just now. Please try again." };
  }
}

/**
 * Create print jobs for every item in an order. Called once an order's payment
 * is confirmed (any channel), so unpaid orders are never dispatchable. Safe to
 * skip if jobs already exist (idempotent guard against double webhooks).
 */
export async function enqueuePrintJobsForOrder(orderId: string): Promise<void> {
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

  // If any item needs a human quality-check (posters), surface the whole order as
  // 'awaiting_approval' so the operator gets the Approve button. Non-review items
  // still print in parallel (the agent claims by job status, not order status);
  // the order only completes once the approved poster prints too.
  const needsApproval = items.some((i) => i.requiresManualReview);
  if (needsApproval) {
    const [o] = await db
      .update(orders)
      .set({ status: 'awaiting_approval' })
      .where(eq(orders.id, orderId))
      .returning({ orderNumber: orders.orderNumber });
    // Alert ops by email so the order doesn't sit unapproved (R2-8). Best-effort.
    if (o) {
      void sendApprovalNeededAlert(o.orderNumber).catch((err) =>
        logger.error({ orderId, err }, 'Failed to send approval-needed alert'),
      );
    }
  }

  logger.info({ orderId, jobs: items.length, needsApproval }, 'Enqueued print jobs after payment');
}

/**
 * 5×7 special handling. An order containing a 5×7 print is operator-gated (manual
 * DNP media swap — see services/store-settings.ts), so the WHOLE order goes to the
 * next working day. This sets orders.scheduled_ready_at to that date and alerts the
 * operator on WhatsApp. Idempotent (acts only while scheduled_ready_at is null) and
 * never throws — failures are logged so they can't block an order. The 5×7 jobs
 * themselves are simply held by the DNP media-mode gate; no job-status change here.
 */
export async function applyFiveBySevenHandling(orderId: string): Promise<void> {
  try {
    const [order] = await db
      .select({ orderNumber: orders.orderNumber, scheduledReadyAt: orders.scheduledReadyAt })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order || order.scheduledReadyAt) return; // missing, or already handled

    const items = await db
      .select({ sizeCode: orderItems.sizeCode })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    const has5x7 = items.some((i) => getProduct(i.sizeCode)?.printer === 'dnp_ds620a_5x7');
    if (!has5x7) return;

    const holidayRows = await db.select({ date: holidays.date }).from(holidays);
    const readyAt = nextWorkingDay(new Date(), new Set(holidayRows.map((h) => h.date)));

    await db.update(orders).set({ scheduledReadyAt: readyAt }).where(eq(orders.id, orderId));
    logger.info(
      { orderId, orderNumber: order.orderNumber, scheduledReadyAt: readyAt },
      '5×7 order — whole order set to next working day',
    );

    await sendFiveBySevenOperatorAlert(order.orderNumber, readyAt);
  } catch (err) {
    logger.error({ orderId, err }, 'applyFiveBySevenHandling failed (order unaffected)');
  }
}

/** Format a date as e.g. "Mon, 22 Jun" in CAT for customer/operator-facing copy. */
export function formatReadyDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Harare',
  });
}

/** WhatsApp the operator that a 5×7 order is waiting and needs a media swap. */
async function sendFiveBySevenOperatorAlert(orderNumber: string, readyAt: Date): Promise<void> {
  // Emailed to OPERATOR_ALERT_EMAIL (notify@…). Best-effort inside the email
  // service; this just hands off the order number + formatted ready date.
  await sendFiveBySevenOperatorEmail(orderNumber, formatReadyDate(readyAt));
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

  // Print jobs are created now (at payment) for ALL channels, so an unpaid order
  // is never dispatchable to a printer. Idempotent — skips if jobs already exist.
  try {
    const paidOrder = await getOrderByNumber(orderNumber);
    if (paidOrder) {
      await enqueuePrintJobsForOrder(paidOrder.id);
    }
  } catch (err) {
    logger.error({ orderNumber, err }, 'Failed to enqueue print jobs after payment');
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

  // 5×7 special handling — next-working-day date + operator alert. Idempotent
  // and self-guarded; runs for whichever channel just got paid.
  const placedOrder = await getOrderByNumber(orderNumber);
  if (placedOrder) {
    await applyFiveBySevenHandling(placedOrder.id);
    // Record the QBO sale as soon as payment is confirmed: settle the order's
    // invoice with a Payment (→ PAID), or post a SalesReceipt for legacy orders.
    // Awaited (but error-swallowed, so a QBO failure never rolls back or blocks a
    // paid order) so the invoice reads PAID before the receipt PDFs — which the
    // callers render right after this returns — are fetched from QBO. Idempotent.
    await recordQboSaleForOrder(placedOrder.id).catch((err) =>
      logger.error({ orderNumber, err }, 'QBO sale posting failed — manual entry may be needed'),
    );
  }
}

/**
 * Resolve the QBO context for an order: line items, the real buyer (so docs post
 * under their QBO customer, not the generic one — web: checkout name + account
 * email + checkout phone; WhatsApp: the customer's name/email/number), and the
 * payment method (drives the deposit account). Shared by invoice-create + paid.
 */
async function gatherQboOrderContext(order: typeof orders.$inferSelect): Promise<{
  items: OrderItemForQbo[];
  customer: QboCustomerInfo | null;
  method: string | null;
}> {
  const rows = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const items: OrderItemForQbo[] = rows.map((i) => ({
    sizeCode:     i.sizeCode,
    quantity:     i.quantity,
    unitPriceUsd: i.unitPriceUsd,
    lineTotalUsd: i.lineTotalUsd,
    productType:  i.productType,
  }));

  let customer: QboCustomerInfo | null = null;
  if (order.channel === 'web' && order.webUserId) {
    const [wu] = await db.select({ email: webUsers.email }).from(webUsers).where(eq(webUsers.id, order.webUserId)).limit(1);
    customer = { name: order.contactName, email: wu?.email ?? null, phone: order.contactPhone };
  } else if (order.customerId) {
    const [c] = await db
      .select({ name: customers.name, email: customers.email, phone: customers.phoneNumber })
      .from(customers)
      .where(eq(customers.id, order.customerId))
      .limit(1);
    if (c) customer = { name: c.name, email: c.email, phone: c.phone };
  }

  // WhatsApp orders are always EcoCash and may not create a payments row, so fall
  // back to the channel when the method wasn't recorded — keeps the QBO deposit
  // routing correct (EcoCash Business rather than Cash on Hand).
  const [payment] = await db
    .select({ paymentMethod: payments.paymentMethod })
    .from(payments)
    .where(eq(payments.orderId, order.id))
    .orderBy(desc(payments.completedAt))
    .limit(1);
  const method = payment?.paymentMethod ?? (order.channel === 'whatsapp' ? 'ecocash' : null);

  return { items, customer, method };
}

/**
 * Create the QBO Invoice for a freshly-created order and persist its id. The
 * sale is recognised here (AR); payment is recorded against this invoice at
 * markOrderPaid. Idempotent (skips if already invoiced; createInvoice also
 * guards by DocNumber) + best-effort — a QBO failure never blocks an order.
 */
export async function createQboInvoiceForOrder(orderId: string): Promise<void> {
  if (!qboEnabled() || !isSetupComplete()) return;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.qboInvoiceId) return; // already invoiced
  const { items, customer } = await gatherQboOrderContext(order);
  const invoiceId = await createInvoice(
    {
      orderNumber:    order.orderNumber,
      subtotalUsd:    order.subtotalUsd,
      deliveryFeeUsd: order.deliveryFeeUsd,
      totalUsd:       order.totalUsd,
      fulfilledAt:    order.fulfilledAt,
      createdAt:      order.createdAt,
    },
    items,
    customer,
  );
  await db.update(orders).set({ qboInvoiceId: invoiceId }).where(eq(orders.id, orderId));
}

/**
 * Record the QBO sale for a paid order. New model: settle the order's invoice
 * with a Payment (→ PAID). Legacy fallback for orders with no invoice (created
 * before invoice-at-create, or invoice creation failed): post a SalesReceipt.
 * Idempotent: no-ops if QBO isn't set up, the invoice is already settled, or a
 * receipt already exists (guards webhook retries / paid + fulfil both firing).
 * Used at markOrderPaid (primary) and as a fallback on fulfil.
 */
export async function recordQboSaleForOrder(orderId: string): Promise<void> {
  if (!qboEnabled() || !isSetupComplete()) return;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;

  const { items, customer, method } = await gatherQboOrderContext(order);

  // Preferred path: settle the AR invoice created at order-create.
  if (order.qboInvoiceId) {
    await recordInvoicePayment(order.qboInvoiceId, order.totalUsd, method);
    return;
  }

  // Legacy fallback: no invoice on this order → post a SalesReceipt as before.
  if (await findSalesReceiptId(order.orderNumber)) return; // already posted
  await createSalesReceipt(
    {
      orderNumber:    order.orderNumber,
      subtotalUsd:    order.subtotalUsd,
      deliveryFeeUsd: order.deliveryFeeUsd,
      totalUsd:       order.totalUsd,
      fulfilledAt:    order.fulfilledAt,
      createdAt:      order.createdAt,
    },
    items,
    method,
    customer,
  );
}

/**
 * Void an order's QBO invoice when an UNPAID checkout is abandoned or cancelled.
 * Paid orders are reversed via a RefundReceipt instead (the invoice has a linked
 * payment), so they're deliberately left alone here. Best-effort.
 */
export async function voidQboInvoiceForOrder(orderId: string): Promise<void> {
  if (!qboEnabled() || !isSetupComplete()) return;
  const [order] = await db
    .select({ qboInvoiceId: orders.qboInvoiceId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order?.qboInvoiceId) return;
  await voidInvoice(order.qboInvoiceId);
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

  // Poster-only orders are gated: hold ALL slips (incl. promo) at
  // 'awaiting_approval' so nothing auto-prints until the operator approves the
  // poster. If the order ALSO has non-poster prints, those + the slips run now
  // and only the poster waits. slip_jobs reuses print_job_status, so
  // 'awaiting_approval' is a valid slip status. Released by the approve endpoint.
  const needsApproval = items.some((i) => i.requiresManualReview);
  const hasOtherPrints = items.some((i) => !i.requiresManualReview);
  const slipStatus = needsApproval && !hasOtherPrints ? ('awaiting_approval' as const) : ('queued' as const);

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
      status: slipStatus,
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
      status: slipStatus,
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
          status: slipStatus,
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
      status: slipStatus,
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
  // Email too — reaches customers who aren't on WhatsApp (R2-4 #4). Best-effort.
  await sendOrderReadyEmail(orderNumber, 'pickup').catch((err) =>
    logger.error({ orderNumber, err }, 'Failed to send ready-for-pickup email'),
  );
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

  const firstName = contact.name.split(/\s+/)[0] ?? contact.name;
  const lastName = contact.name.split(/\s+/).pop() ?? contact.name;

  // Use the order's chosen collection point (falls back to primary, then env).
  const point = await getOrderCollectionPoint(order.collectionPointId);
  const locName = point?.name ?? env.BUSINESS_NAME;
  const locAddress = point?.addressLine ?? env.BUSINESS_ADDRESS;
  const locHours = point ? pointHours(point) : env.BUSINESS_HOURS;

  // Notify the buyer, plus the gift recipient if this order is for someone else
  // (R2-13). Each send is best-effort so one failure doesn't block the other.
  const phones = recipientPhones(contact.phone, order.recipientPhone);
  for (const phone of phones) {
    // Prefer the approved template (delivers outside the 24h window — e.g. web
    // orders); fall back to free-form text when no template is configured.
    if (env.WHATSAPP_TEMPLATE_PICKUP) {
      // {{1}} name, {{2}} order, {{3}} hours, {{4}} address
      await sendWhatsAppTemplate(phone, env.WHATSAPP_TEMPLATE_PICKUP, [
        firstName,
        orderNumber,
        locHours,
        `${locName}, ${locAddress}`,
      ]).catch((err) => logger.error({ orderNumber, phone, err }, 'Pickup notify failed for a recipient'));
    } else {
      const navLine = point?.mapsUrl ? `\n\n🧭 Navigate: ${point.mapsUrl}` : '';
      const message = `✅ Your order is ready!\n\nOrder: *${orderNumber}*\nName: *${lastName}*\n\nPick up at *${locName}* during business hours (${locHours}).\n\nAt the counter, just give your last name or order number.\n\n📍 ${locAddress}${navLine}`;
      await sendWhatsAppMessage(phone, message).catch((err) => logger.error({ orderNumber, phone, err }, 'Pickup notify failed for a recipient'));
    }
  }
  logger.info({ orderNumber, recipients: phones.length, template: !!env.WHATSAPP_TEMPLATE_PICKUP }, 'Sent ready-for-pickup notification');
}

/** The distinct phones to notify for an order: the buyer plus the gift recipient
 * (R2-13), if set and different. Normalised + deduped. */
function recipientPhones(buyerPhone: string, recipientPhone: string | null): string[] {
  const out = [buyerPhone];
  if (recipientPhone && recipientPhone !== buyerPhone) out.push(recipientPhone);
  return out;
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
  // Email too — reaches customers who aren't on WhatsApp (R2-4 #4/#7). Best-effort.
  await sendOrderReadyEmail(order.orderNumber, 'delivery').catch((err) =>
    logger.error({ orderId, err }, 'Failed to send out-for-delivery email'),
  );
}

/**
 * Notify the customer their order is complete (collected/delivered) — thank-you
 * on WhatsApp AND email (R2-4 #6). Best-effort; called from the admin fulfil
 * action. The status update is the caller's responsibility.
 */
export async function notifyOrderFulfilled(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) return;
  const contact = await resolveOrderContact(order);
  if (contact) {
    // Thank both the buyer and the gift recipient if set (R2-13).
    for (const phone of recipientPhones(contact.phone, order.recipientPhone)) {
      await sendWhatsAppMessage(phone, MSG.orderFulfilled(orderNumber)).catch((err) =>
        logger.error({ orderNumber, phone, err }, 'Failed to send fulfilled WhatsApp'),
      );
    }
  }
  await sendOrderFulfilledEmail(orderNumber).catch((err) =>
    logger.error({ orderNumber, err }, 'Failed to send fulfilled email'),
  );
}

/**
 * Send the customer a WhatsApp message that their delivery order is on its way.
 */
async function sendOutForDeliveryNotification(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) return;

  const contact = await resolveOrderContact(order);
  if (!contact) return;

  const lastName = contact.name.split(/\s+/).pop() ?? contact.name;

  const message = `🚚 Your order is on its way!\n\nOrder: *${orderNumber}*\nName: *${lastName}*\n\nYour prints have left *${env.BUSINESS_NAME}* and are out for delivery. Our driver will be in touch shortly.\n\nQuestions? Just reply to this message.`;

  // Notify the buyer + the gift recipient if set (R2-13). Best-effort each.
  for (const phone of recipientPhones(contact.phone, order.recipientPhone)) {
    await sendWhatsAppMessage(phone, message).catch((err) =>
      logger.error({ orderNumber, phone, err }, 'Out-for-delivery notify failed for a recipient'),
    );
  }
  logger.info({ orderNumber }, 'Sent out-for-delivery notification');
}

/**
 * Cancel an order.
 * Called when customer types CANCEL or payment times out.
 */
export async function cancelOrder(orderNumber: string): Promise<void> {
  const [cancelled] = await db
    .update(orders)
    .set({ status: 'cancelled' })
    .where(eq(orders.orderNumber, orderNumber))
    .returning({ id: orders.id });

  logger.info({ orderNumber }, 'Order cancelled');

  // Void the AR invoice for this abandoned/cancelled (unpaid) order. Best-effort.
  if (cancelled) {
    void voidQboInvoiceForOrder(cancelled.id).catch((err) =>
      logger.error({ orderNumber, err }, 'QBO invoice void failed on cancel'),
    );
  }
}

/**
 * Cancel pending_payment orders older than maxAgeHours (default 24).
 *
 * Abandoned checkouts otherwise accumulate as pending_payment forever — admin
 * clutter, and a stale order is a resurrection target for a late webhook or
 * the dev mock confirm. Their still-pending payments rows are cancelled too;
 * success/failed payment rows are left untouched as history.
 */
// Media-switch alert guard — don't re-email every sweep tick while the backlog
// persists; re-arms once it clears (single backend instance, so module state ok).
let lastMediaAlertAt = 0;
const MEDIA_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Alert ops when dye-sub jobs are stuck on the wrong loaded media (R2-9). The DNP
 * serves only jobs whose media matches the current mode, so if it's left on 5×7
 * while 4×6 orders arrive (or vice-versa) those jobs wait. When any has waited
 * past maxWaitMs, email once (cooldown-guarded); re-arms when the backlog clears.
 */
export async function checkMediaSwitchNeeded(maxWaitMs = 10 * 60 * 1000): Promise<void> {
  try {
    const mode = await getDnpMediaMode();
    const waitingType: 'dye_sub_5x7' | 'dye_sub_4x6' = mode === '6x8' ? 'dye_sub_5x7' : 'dye_sub_4x6';
    const cutoff = new Date(Date.now() - maxWaitMs);
    const waiting = await db
      .select({ id: printJobs.id })
      .from(printJobs)
      .where(
        and(
          eq(printJobs.status, 'queued'),
          eq(printJobs.targetPrinterType, waitingType),
          lt(printJobs.queuedAt, cutoff),
        ),
      );
    if (waiting.length === 0) {
      lastMediaAlertAt = 0; // backlog cleared — re-arm
      return;
    }
    if (Date.now() - lastMediaAlertAt < MEDIA_ALERT_COOLDOWN_MS) return;
    lastMediaAlertAt = Date.now();
    const neededMedia = mode === '6x8' ? '5x7' : '6x8';
    await sendMediaSwitchAlert(mode, neededMedia, waiting.length);
  } catch (err) {
    logger.error({ err }, 'checkMediaSwitchNeeded failed');
  }
}

export async function expireStalePendingOrders(maxAgeHours = 24): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const expired = await db
      .update(orders)
      .set({ status: 'cancelled' })
      .where(and(eq(orders.status, 'pending_payment'), lt(orders.createdAt, cutoff)))
      .returning({ id: orders.id, orderNumber: orders.orderNumber, qboInvoiceId: orders.qboInvoiceId });
    if (expired.length === 0) return 0;

    // Void the AR invoice for each abandoned checkout so no open invoice lingers
    // in QBO. Best-effort, per order — one failure must not abort the sweep.
    for (const o of expired) {
      if (!o.qboInvoiceId) continue;
      await voidQboInvoiceForOrder(o.id).catch((err) =>
        logger.error({ orderNumber: o.orderNumber, err }, 'QBO invoice void failed on expiry'),
      );
    }

    await db
      .update(payments)
      .set({ status: 'cancelled' })
      .where(
        and(
          inArray(payments.orderId, expired.map((o) => o.id)),
          eq(payments.status, 'pending'),
        ),
      );

    logger.info(
      { count: expired.length, orderNumbers: expired.map((o) => o.orderNumber) },
      'Expired stale pending_payment orders',
    );
    return expired.length;
  } catch (err) {
    logger.error({ err }, 'Failed to expire stale pending_payment orders');
    return 0;
  }
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
