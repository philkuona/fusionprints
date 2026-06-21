/**
 * Admin operations — data/ops layer (audit IMP-2).
 *
 * The order-management surface (status transitions, reprints, receipts, printer
 * status, dashboard metrics, the active/completed order tallies) used to live
 * inline in routes/admin-ops.ts, mixed with 900+ lines of HTML. This module is
 * the pure data/ops half — no HTML, no Fastify — so it's unit-testable and the
 * route file is just auth + HTML + wiring.
 */

import { eq, and, gte, lte, sql, isNotNull, inArray, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  orders,
  orderItems,
  printJobs,
  slipJobs,
  printers,
  customers,
  webUsers,
  type InkLevel,
} from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { env } from '@/config/env.js';
import { markOrderShipped } from '@/services/order.js';
import { sendOrderReceipt } from '@/services/web-order-email.js';
import { sendWhatsAppReceipt } from '@/services/receipt-pdf.js';
import { getProduct } from '@/config/catalog.js';

// ===== Order status transitions =====

/**
 * Mark an order as shipped/out for delivery (only valid for delivery orders).
 * Delegates to the order service, which updates status + sends the customer a
 * WhatsApp "on its way" notification (best effort).
 */
export async function markShipped(orderId: string): Promise<void> {
  await markOrderShipped(orderId);
}

// ===== Reprint logic =====

/**
 * Reprint a single failed print job.
 * Resets status to queued so the agent picks it up on next poll.
 */
export async function reprintJob(jobId: string): Promise<void> {
  // A job id is either a print job or a slip job (UUIDs are unique across both),
  // so reset in both tables — one update is a no-op.
  await db
    .update(printJobs)
    .set({
      status: 'queued',
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(printJobs.id, jobId));
  await db
    .update(slipJobs)
    .set({
      status: 'queued',
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(slipJobs.id, jobId));
  logger.info({ jobId }, 'Print/slip job requeued for reprint');
}

/**
 * Reprint all failed jobs in an order.
 */
export async function reprintOrder(orderId: string): Promise<number> {
  const result = await db
    .update(printJobs)
    .set({
      status: 'queued',
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    })
    .where(
      sql`${printJobs.orderItemId} IN (
        SELECT id FROM order_items WHERE order_id = ${orderId}
      ) AND ${printJobs.status} = 'failed'`,
    )
    .returning({ id: printJobs.id });

  // Failed slips for the same order (separator / order-info / promos).
  const slipResult = await db
    .update(slipJobs)
    .set({
      status: 'queued',
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    })
    .where(and(eq(slipJobs.orderId, orderId), eq(slipJobs.status, 'failed')))
    .returning({ id: slipJobs.id });

  // Bump the order back to printing if it was marked failed
  await db
    .update(orders)
    .set({ status: 'queued_for_print' })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'failed')));

  const count = result.length + slipResult.length;
  logger.info({ orderId, prints: result.length, slips: slipResult.length }, 'Order print/slip jobs requeued');
  return count;
}

/**
 * Reprint a batch of jobs by ID.
 */
export async function reprintJobBatch(jobIds: string[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const idList = sql.join(jobIds.map((id) => sql`${id}`), sql`, `);
  const result = await db
    .update(printJobs)
    .set({
      status: 'queued',
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    })
    .where(sql`${printJobs.id} IN (${idList})`)
    .returning({ id: printJobs.id });

  // Ids may reference slip jobs too (separator / order-info / promos).
  const slipResult = await db
    .update(slipJobs)
    .set({
      status: 'queued',
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    })
    .where(sql`${slipJobs.id} IN (${idList})`)
    .returning({ id: slipJobs.id });

  const count = result.length + slipResult.length;
  logger.info({ prints: result.length, slips: slipResult.length }, 'Batch of jobs requeued');
  return count;
}

/**
 * Reset stuck jobs that have been "printing" for too long.
 * If the agent crashed mid-job, the database thinks the job is still printing.
 * This gives admins a one-click way to reset and let the agent re-pick.
 */
export async function resetStuckJobs(maxAgeMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const result = await db
    .update(printJobs)
    .set({
      status: 'queued',
      startedAt: null,
      errorMessage: null,
    })
    .where(
      and(
        eq(printJobs.status, 'printing'),
        isNotNull(printJobs.startedAt),
        lte(printJobs.startedAt, cutoff),
      ),
    )
    .returning({ id: printJobs.id });

  logger.info({ count: result.length, maxAgeMinutes }, 'Reset stuck print jobs');
  return result.length;
}

// ===== Printer status =====

export interface PrinterStatusInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  lastHeartbeat: Date | null;
  staleness: 'online' | 'stale' | 'offline';
  mediaRemaining: number | null;
  errorMessage: string | null;
  currentMedia: string | null;
  inkLevels: InkLevel[] | null;
}

export async function getPrinterStatus(): Promise<PrinterStatusInfo[]> {
  const rows = await db.select().from(printers);

  const now = Date.now();
  return rows.map((p) => {
    let staleness: 'online' | 'stale' | 'offline' = 'offline';
    if (p.lastHeartbeatAt) {
      const ageMs = now - p.lastHeartbeatAt.getTime();
      if (ageMs < 2 * 60 * 1000) staleness = 'online';
      else if (ageMs < 10 * 60 * 1000) staleness = 'stale';
    }

    return {
      id: p.id,
      name: p.name,
      type: p.printerType,
      // If we haven't heard from the agent recently, the stored status is stale —
      // report 'offline' rather than a frozen 'online' from hours ago.
      status: staleness === 'online' ? p.status : 'offline',
      lastHeartbeat: p.lastHeartbeatAt,
      staleness,
      mediaRemaining: null, // not tracked in current schema
      errorMessage: null,
      currentMedia: p.currentMedia,
      inkLevels: p.inkLevels ?? null,
    };
  });
}

// ===== Metrics =====

export async function getDashboardMetrics(daysBack = 30) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  // Revenue and order counts
  const [revenue] = await db
    .select({
      totalRevenue: sql<string>`COALESCE(SUM(${orders.totalUsd}), 0)::text`,
      orderCount: sql<string>`COUNT(*)::text`,
      avgOrderValue: sql<string>`COALESCE(AVG(${orders.totalUsd}), 0)::text`,
    })
    .from(orders)
    .where(
      and(
        gte(orders.createdAt, cutoff),
        sql`${orders.status} NOT IN ('pending_payment', 'cancelled')`,
      ),
    );

  // Status breakdown
  const statusBreakdown = await db
    .select({
      status: orders.status,
      count: sql<string>`COUNT(*)::text`,
    })
    .from(orders)
    .where(gte(orders.createdAt, cutoff))
    .groupBy(orders.status);

  // Print volume by size (with consumable cost snapshotted on each order item)
  const sizeBreakdown = await db
    .select({
      sizeCode: orderItems.sizeCode,
      totalPrints: sql<string>`SUM(${orderItems.quantity})::text`,
      revenue: sql<string>`SUM(${orderItems.lineTotalUsd})::text`,
      cost: sql<string>`COALESCE(SUM(${orderItems.lineCostUsd}), 0)::text`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        gte(orders.createdAt, cutoff),
        sql`${orders.status} NOT IN ('pending_payment', 'cancelled')`,
      ),
    )
    .groupBy(orderItems.sizeCode);

  // Total consumable cost in the period (sum of snapshotted line costs).
  const [costAgg] = await db
    .select({ totalCost: sql<string>`COALESCE(SUM(${orderItems.lineCostUsd}), 0)::text` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        gte(orders.createdAt, cutoff),
        sql`${orders.status} NOT IN ('pending_payment', 'cancelled')`,
      ),
    );

  // Daily revenue for last 14 days (for chart)
  const dailyRevenue = await db
    .select({
      day: sql<string>`DATE(${orders.createdAt})::text`,
      revenue: sql<string>`COALESCE(SUM(${orders.totalUsd}), 0)::text`,
      orders: sql<string>`COUNT(*)::text`,
    })
    .from(orders)
    .where(
      and(
        gte(orders.createdAt, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)),
        sql`${orders.status} NOT IN ('pending_payment', 'cancelled')`,
      ),
    )
    .groupBy(sql`DATE(${orders.createdAt})`)
    .orderBy(sql`DATE(${orders.createdAt})`);

  // New customer count
  const [newCustomers] = await db
    .select({
      count: sql<string>`COUNT(*)::text`,
    })
    .from(customers)
    .where(gte(customers.createdAt, cutoff));

  // Repeat customer rate
  const [repeatRate] = await db
    .select({
      repeatCustomers: sql<string>`COUNT(*)::text`,
    })
    .from(
      db
        .select({ customerId: orders.customerId })
        .from(orders)
        .where(
          and(
            gte(orders.createdAt, cutoff),
            sql`${orders.status} NOT IN ('pending_payment', 'cancelled')`,
          ),
        )
        .groupBy(orders.customerId)
        .having(sql`COUNT(*) > 1`)
        .as('repeat'),
    );

  // Failed jobs count
  const [failedJobs] = await db
    .select({
      count: sql<string>`COUNT(*)::text`,
    })
    .from(printJobs)
    .where(eq(printJobs.status, 'failed'));

  // Cancelled orders in the period (count + value) — audit metric (R2-10 #25).
  const [cancelledAgg] = await db
    .select({
      count: sql<string>`COUNT(*)::text`,
      valueUsd: sql<string>`COALESCE(SUM(${orders.totalUsd}), 0)::text`,
    })
    .from(orders)
    .where(and(gte(orders.createdAt, cutoff), eq(orders.status, 'cancelled')));

  const totalRevenue = parseFloat(revenue?.totalRevenue ?? '0');
  const totalCost = parseFloat(costAgg?.totalCost ?? '0');
  const marginUsd = totalRevenue - totalCost;

  return {
    daysBack,
    revenue: {
      totalUsd: totalRevenue,
      orderCount: parseInt(revenue?.orderCount ?? '0', 10),
      avgOrderValue: parseFloat(revenue?.avgOrderValue ?? '0'),
    },
    // Consumable cost + gross margin. Cost is 0 until per-size costs are set on
    // the Pricing page (and only fills forward — pre-feature orders snapshot null).
    cost: {
      totalUsd: totalCost,
      marginUsd,
      marginPct: totalRevenue > 0 ? Math.round((marginUsd / totalRevenue) * 100) : 0,
    },
    statusBreakdown: statusBreakdown.map((r) => ({
      status: r.status,
      count: parseInt(r.count, 10),
    })),
    sizeBreakdown: sizeBreakdown.map((r) => {
      const rev = parseFloat(r.revenue);
      const cost = parseFloat(r.cost);
      return {
        sizeCode: r.sizeCode,
        totalPrints: parseInt(r.totalPrints, 10),
        revenue: rev,
        cost,
        marginPct: rev > 0 ? Math.round(((rev - cost) / rev) * 100) : 0,
      };
    }),
    dailyRevenue: dailyRevenue.map((r) => ({
      day: r.day,
      revenue: parseFloat(r.revenue),
      orders: parseInt(r.orders, 10),
    })),
    customers: {
      newInPeriod: parseInt(newCustomers?.count ?? '0', 10),
      repeatInPeriod: parseInt(repeatRate?.repeatCustomers ?? '0', 10),
    },
    operational: {
      failedJobs: parseInt(failedJobs?.count ?? '0', 10),
    },
    cancellations: {
      count: parseInt(cancelledAgg?.count ?? '0', 10),
      valueUsd: parseFloat(cancelledAgg?.valueUsd ?? '0'),
    },
  };
}

// ===== Receipt generation =====

/**
 * Generate a plain-text receipt for an order. Used both for:
 *   - WhatsApp delivery (just send as a text message)
 *   - Email body fallback if HTML can't render
 *
 * The receipt shows order number, items, totals, and collection details.
 */
export async function generateReceiptText(orderId: string): Promise<string | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return null;
  if (!order.customerId) return null; // WhatsApp-customer receipt; web receipts handled separately

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, order.customerId))
    .limit(1);
  if (!customer) return null;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  const lines: string[] = [];
  lines.push(`*FusionPrints Receipt*`);
  lines.push(`Order *${order.orderNumber}*`);
  lines.push('');
  lines.push(`Customer: ${customer.name ?? customer.phoneNumber}`);
  lines.push(`Date: ${order.createdAt.toLocaleDateString('en-ZW', { year: 'numeric', month: 'long', day: 'numeric' })}`);
  lines.push('');
  lines.push('*Items*');
  for (const item of items) {
    const total = parseFloat(item.lineTotalUsd);
    // order_items stores only sizeCode; the human label lives in the catalog.
    const label = getProduct(item.sizeCode)?.displayLabel ?? item.sizeCode;
    lines.push(`  • ${item.quantity} × ${label} — $${total.toFixed(2)}`);
  }
  lines.push('');
  lines.push(`Subtotal: $${parseFloat(order.subtotalUsd).toFixed(2)}`);
  if (parseFloat(order.deliveryFeeUsd) > 0) {
    lines.push(`Delivery: $${parseFloat(order.deliveryFeeUsd).toFixed(2)}`);
  }
  lines.push(`*Total: $${parseFloat(order.totalUsd).toFixed(2)}*`);
  lines.push('');
  if (order.fulfillmentMethod === 'collection') {
    lines.push(`📍 Collect at: ${env.BUSINESS_COLLECTION_ADDRESS || 'our shop'}`);
    lines.push(`Hours: ${env.BUSINESS_HOURS}`);
  } else {
    lines.push(`🚚 Delivery to:`);
    lines.push(`   ${order.deliveryAddress ?? '(address on file)'}`);
  }
  lines.push('');
  lines.push(`Thank you for choosing FusionPrints!`);
  lines.push(`_Save this receipt for your records._`);

  return lines.join('\n');
}

/**
 * Resend the branded receipt to the customer on BOTH channels the order has
 * (R2-2). The primary receipt fires automatically on payment; this is the
 * admin "Resend Receipt" action. Email is forced past the once-only guard;
 * each channel self-guards (email: no-op without an address; WhatsApp PDF:
 * no-op for web orders). Best-effort.
 */
export async function resendReceipt(orderId: string): Promise<boolean> {
  const [order] = await db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return false;
  await sendOrderReceipt(order.orderNumber, { force: true }).catch((err) =>
    logger.error({ err, orderId }, 'Resend receipt email failed'),
  );
  await sendWhatsAppReceipt(order.orderNumber).catch((err) =>
    logger.error({ err, orderId }, 'Resend receipt WhatsApp failed'),
  );
  return true;
}

/**
 * Send a receipt to the customer via WhatsApp.
 * Returns true on success, false on failure.
 */
export async function sendReceiptViaWhatsApp(orderId: string): Promise<boolean> {
  const text = await generateReceiptText(orderId);
  if (!text) return false;

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return false;
  if (!order.customerId) return false; // WhatsApp receipt path; web orders handled separately

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, order.customerId))
    .limit(1);
  if (!customer) return false;

  // Strip the leading '+' for WhatsApp's E.164 format requirement
  const to = customer.phoneNumber.replace(/^\+/, '');

  try {
    const response = await fetch(`${env.WHATSAPP_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'D360-API-KEY': env.WHATSAPP_API_KEY,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ orderId, status: response.status, error: errBody }, 'Failed to send receipt via WhatsApp');
      return false;
    }

    // Mark receipt as sent
    await db
      .update(orders)
      .set({ receiptSentAt: new Date() })
      .where(eq(orders.id, orderId));

    logger.info({ orderId, customerId: customer.id }, 'Receipt sent via WhatsApp');
    return true;
  } catch (err) {
    logger.error({ err, orderId }, 'Error sending receipt');
    return false;
  }
}

// ===== Order Management (Active + Completed tabs) =====

// Active = in the print pipeline; Completed = printed onward.
const ACTIVE_STATUSES = ['paid', 'awaiting_approval', 'queued_for_print', 'printing'] as const;
const COMPLETED_STATUSES = ['printed', 'ready_for_pickup', 'ready_for_collection', 'shipped', 'fulfilled'] as const;

// Name across channels: WhatsApp customer, else web user.
const nameExpr = sql<string | null>`COALESCE(${customers.name}, ${webUsers.displayName}, ${webUsers.email})`;

type Bucket = 'small' | 'fiveinch' | 'large' | 'poster';
function bucketFor(productType: string, sizeCode: string): Bucket {
  if (productType === 'poster') return 'poster';
  if (sizeCode === '4x6') return 'small';
  if (sizeCode === '5x7') return 'fiveinch';
  return 'large'; // 6x6, 6x8, 8x10
}

export interface Tally {
  done: number;
  total: number;
}
const emptyTally = (): Tally => ({ done: 0, total: 0 });

export interface ActiveOrderRow {
  id: string;
  orderNumber: string;
  createdAt: Date;
  status: string;
  name: string | null;
  small: Tally;
  fiveinch: Tally;
  large: Tally;
  poster: Tally;
  slips: Tally; // separator + order-info + promos (excludes envelope label)
  failed: number;
}

export async function getActiveOrders(): Promise<ActiveOrderRow[]> {
  const ords = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      createdAt: orders.createdAt,
      status: orders.status,
      name: nameExpr,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(webUsers, eq(orders.webUserId, webUsers.id))
    .where(inArray(orders.status, [...ACTIVE_STATUSES]))
    .orderBy(orders.createdAt);
  if (ords.length === 0) return [];
  const ids = ords.map((o) => o.id);

  const prints = await db
    .select({
      orderId: orderItems.orderId,
      productType: orderItems.productType,
      sizeCode: orderItems.sizeCode,
      status: printJobs.status,
    })
    .from(printJobs)
    .innerJoin(orderItems, eq(printJobs.orderItemId, orderItems.id))
    .where(inArray(orderItems.orderId, ids));

  const slips = await db
    .select({ orderId: slipJobs.orderId, status: slipJobs.status, slipType: slipJobs.slipType })
    .from(slipJobs)
    .where(inArray(slipJobs.orderId, ids));

  const map = new Map<string, ActiveOrderRow>();
  for (const o of ords) {
    map.set(o.id, {
      ...o,
      small: emptyTally(),
      fiveinch: emptyTally(),
      large: emptyTally(),
      poster: emptyTally(),
      slips: emptyTally(),
      failed: 0,
    });
  }
  for (const p of prints) {
    const m = map.get(p.orderId);
    if (!m) continue;
    const t = m[bucketFor(p.productType, p.sizeCode)];
    t.total++;
    if (p.status === 'done') t.done++;
    if (p.status === 'failed') m.failed++;
  }
  for (const s of slips) {
    if (s.slipType === 'envelope_label') continue; // label excluded from the count
    const m = map.get(s.orderId);
    if (!m) continue;
    m.slips.total++;
    if (s.status === 'done') m.slips.done++;
    if (s.status === 'failed') m.failed++;
  }
  return ords.map((o) => map.get(o.id)!);
}

export async function getCompletedOrdersList() {
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      createdAt: orders.createdAt,
      status: orders.status,
      totalUsd: orders.totalUsd,
      fulfillmentMethod: orders.fulfillmentMethod,
      name: nameExpr,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(webUsers, eq(orders.webUserId, webUsers.id))
    .where(inArray(orders.status, [...COMPLETED_STATUSES]))
    .orderBy(desc(orders.createdAt))
    .limit(100);
}

/**
 * Cancelled orders — retained for audit (R2-10 #25). They appear in neither the
 * Active nor Completed lists, so without this a cancellation vanishes from the
 * dashboard. Includes the refund status so the operator sees where money stands.
 */
export async function getCancelledOrdersList() {
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      createdAt: orders.createdAt,
      totalUsd: orders.totalUsd,
      fulfillmentMethod: orders.fulfillmentMethod,
      refundStatus: orders.refundStatus,
      name: nameExpr,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(webUsers, eq(orders.webUserId, webUsers.id))
    .where(eq(orders.status, 'cancelled'))
    .orderBy(desc(orders.createdAt))
    .limit(100);
}
