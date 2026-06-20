/**
 * Cancellation + refund (PR-12).
 *
 * Flow: a customer REQUESTS cancellation of a paid order (web account page) →
 * an admin APPROVES (or declines) in the order modal → on approval we issue the
 * real Payonify refund, mark the order cancelled, stop any orphaned print/slip
 * jobs, post a QBO refund receipt, and notify the customer. Refunds are NEVER
 * automatic — they only happen when an admin approves.
 *
 * payonify.refundPayment is the single seam to the gateway; everything else here
 * is DB + bookkeeping + notification and is provider-agnostic.
 */
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, payments, printJobs, slipJobs } from '@/db/schema.js';
import { refundPayment } from '@/services/payonify.js';
import { isEnabled as qboEnabled, isSetupComplete, createRefundReceipt } from '@/services/qbo.js';
import { sendRefundIssuedEmail, sendCancellationDeclinedEmail } from '@/services/web-order-email.js';
import { sendCancellationRequestAlert } from '@/services/operator-email.js';
import { notifyCustomerOfCancellation } from '@/routes/payment-webhooks.js';
import { logger } from '@/utils/logger.js';

/**
 * Order statuses a customer may request cancellation from. Once an order has
 * been printed / released / shipped / fulfilled (or already cancelled), the work
 * is done or out the door, so the request is refused — the customer is directed
 * to contact support instead.
 */
const CANCELLABLE_STATUSES = ['paid', 'awaiting_approval', 'queued_for_print', 'printing'] as const;

/**
 * Whether a customer may (still) request cancellation: the order is paid, not
 * yet too far along, and doesn't already have a pending/approved request.
 */
export function canRequestCancellation(order: {
  status: string;
  paidAt: Date | null;
  cancellationStatus: string | null;
}): boolean {
  if (!order.paidAt) return false;
  if (order.cancellationStatus === 'requested' || order.cancellationStatus === 'approved') return false;
  return (CANCELLABLE_STATUSES as readonly string[]).includes(order.status);
}

export interface CancellationRequestResult {
  ok: boolean;
  reason?: string;
}

/**
 * Customer-initiated: record a cancellation request against a paid order. Does
 * NOT move money — just flags the order for admin review. Idempotent-ish: a
 * second request while one is pending is a no-op success.
 */
export async function requestOrderCancellation(params: {
  orderId: string;
  reason?: string | null;
}): Promise<CancellationRequestResult> {
  const [order] = await db.select().from(orders).where(eq(orders.id, params.orderId)).limit(1);
  if (!order) return { ok: false, reason: 'not_found' };

  if (order.cancellationStatus === 'requested') return { ok: true }; // already pending
  if (order.status === 'cancelled') return { ok: false, reason: 'already_cancelled' };
  if (!order.paidAt) return { ok: false, reason: 'not_paid' };
  if (!(CANCELLABLE_STATUSES as readonly string[]).includes(order.status)) {
    return { ok: false, reason: 'too_late' };
  }

  await db
    .update(orders)
    .set({
      cancellationStatus: 'requested',
      cancellationReason: params.reason?.trim()?.slice(0, 500) || null,
      cancellationRequestedAt: new Date(),
    })
    .where(eq(orders.id, params.orderId));

  logger.info({ orderId: params.orderId, orderNumber: order.orderNumber }, 'Cancellation requested by customer');

  // Alert ops by email so the request gets reviewed (best-effort, never blocks).
  void sendCancellationRequestAlert(order.orderNumber, order.totalUsd, params.reason?.trim() || null).catch((err) =>
    logger.error({ err, orderId: params.orderId }, 'Cancellation request alert failed'),
  );
  return { ok: true };
}

export interface RefundResult {
  ok: boolean;
  reason?: string;
  refundReference?: string;
}

/**
 * Admin-approved: issue the Payonify refund, then cancel the order + bookkeeping.
 * Ordered so money moves FIRST — if the gateway refund fails we mark refundStatus
 * 'failed', leave the request open, and DON'T cancel the order (so the operator
 * can retry or handle it manually). Idempotent: a second call on an
 * already-refunded order is a no-op success.
 */
export async function approveCancellationAndRefund(orderId: string): Promise<RefundResult> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.refundStatus === 'succeeded') return { ok: true, refundReference: order.refundReference ?? undefined };
  if (!order.paidAt) return { ok: false, reason: 'not_paid' };

  // Find the successful payment + its refundable charge id.
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'success')))
    .limit(1);
  if (!payment) return { ok: false, reason: 'no_payment' };

  const chargeRef = payment.chargeReference ?? payment.providerReference;
  if (!chargeRef || payment.provider === 'virtual') {
    return { ok: false, reason: 'no_charge_reference' };
  }

  // 1) Move the money. Mark pending first so a crash mid-call is visible.
  await db.update(orders).set({ refundStatus: 'pending', cancellationStatus: 'approved' }).where(eq(orders.id, orderId));
  let refundReference: string;
  try {
    const refund = await refundPayment({
      chargeReference: chargeRef,
      amountUsd: Number(order.totalUsd),
      orderNumber: order.orderNumber,
    });
    refundReference = refund.id;
  } catch (err) {
    await db.update(orders).set({ refundStatus: 'failed' }).where(eq(orders.id, orderId));
    logger.error({ err, orderId, orderNumber: order.orderNumber }, 'Refund failed — order left intact for retry');
    return { ok: false, reason: 'gateway_error' };
  }

  // 2) Money's back. Cancel the order + record the refund.
  await db
    .update(orders)
    .set({
      status: 'cancelled',
      refundStatus: 'succeeded',
      refundReference,
      refundAmountUsd: order.totalUsd,
      refundedAt: new Date(),
    })
    .where(eq(orders.id, orderId));
  await db.update(payments).set({ status: 'cancelled' }).where(eq(payments.id, payment.id));

  // 3) Stop any work still in the pipeline (queued / awaiting approval → failed,
  // so the print agent never dispatches them). In-flight 'printing' jobs are
  // already at the printer and are left alone.
  await stopPipelineJobs(orderId);

  // 4) QBO refund receipt (fire-and-forget; accounting only, never blocks).
  if (qboEnabled() && isSetupComplete()) {
    void postQboRefundReceipt(orderId, payment.paymentMethod ?? null).catch((err) =>
      logger.error({ err, orderId }, 'QBO Refund Receipt failed — manual entry needed'),
    );
  }

  // 5) Tell the customer (email for web, WhatsApp for bot). Best-effort.
  void notifyRefundIssued(order.orderNumber, order.channel, order.webUserId, order.customerId).catch((err) =>
    logger.error({ err, orderId }, 'Refund notification failed'),
  );

  logger.info({ orderId, orderNumber: order.orderNumber, refundReference }, 'Cancellation approved + refunded');
  return { ok: true, refundReference };
}

/** Admin declined the request: clear the pending flag, keep the order live, notify. */
export async function declineCancellation(orderId: string): Promise<{ ok: boolean; reason?: string }> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return { ok: false, reason: 'not_found' };

  await db.update(orders).set({ cancellationStatus: 'declined' }).where(eq(orders.id, orderId));
  void notifyCancellationDeclined(order.orderNumber, order.channel, order.webUserId, order.customerId).catch((err) =>
    logger.error({ err, orderId }, 'Decline notification failed'),
  );
  logger.info({ orderId, orderNumber: order.orderNumber }, 'Cancellation declined');
  return { ok: true };
}

// ── internals ───────────────────────────────────────────────────────────────

/** Fail any not-yet-dispatched print + slip jobs for an order. */
async function stopPipelineJobs(orderId: string): Promise<void> {
  const items = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId));
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    await db
      .update(printJobs)
      .set({ status: 'failed' })
      .where(and(inArray(printJobs.orderItemId, itemIds), inArray(printJobs.status, ['queued', 'awaiting_approval'])));
  }
  await db
    .update(slipJobs)
    .set({ status: 'failed' })
    .where(and(eq(slipJobs.orderId, orderId), inArray(slipJobs.status, ['queued', 'awaiting_approval'])));
}

/** Build args + post a QBO refund receipt for a cancelled order. */
async function postQboRefundReceipt(orderId: string, paymentMethod: string | null): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  await createRefundReceipt(
    {
      orderNumber: order.orderNumber,
      subtotalUsd: order.subtotalUsd,
      deliveryFeeUsd: order.deliveryFeeUsd,
      totalUsd: order.totalUsd,
      fulfilledAt: order.fulfilledAt,
      createdAt: order.createdAt,
    },
    items.map((i) => ({
      sizeCode: i.sizeCode,
      quantity: i.quantity,
      unitPriceUsd: i.unitPriceUsd,
      lineTotalUsd: i.lineTotalUsd,
      productType: i.productType,
    })),
    paymentMethod,
  );
}

async function notifyRefundIssued(
  orderNumber: string,
  channel: string,
  webUserId: string | null,
  customerId: string | null,
): Promise<void> {
  if (channel === 'web' && webUserId) {
    await sendRefundIssuedEmail(orderNumber).catch((err) => logger.error({ err, orderNumber }, 'Refund email failed'));
  }
  if (customerId) {
    await notifyCustomerOfCancellation(orderNumber, 'refunded').catch((err) =>
      logger.error({ err, orderNumber }, 'Refund WhatsApp failed'),
    );
  }
}

async function notifyCancellationDeclined(
  orderNumber: string,
  channel: string,
  webUserId: string | null,
  customerId: string | null,
): Promise<void> {
  if (channel === 'web' && webUserId) {
    await sendCancellationDeclinedEmail(orderNumber).catch((err) =>
      logger.error({ err, orderNumber }, 'Decline email failed'),
    );
  }
  if (customerId) {
    await notifyCustomerOfCancellation(orderNumber, 'declined').catch((err) =>
      logger.error({ err, orderNumber }, 'Decline WhatsApp failed'),
    );
  }
}
