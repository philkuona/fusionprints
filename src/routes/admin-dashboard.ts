/**
 * Admin Dashboard
 *
 * A password-protected web interface for managing FusionPrints orders.
 * Served directly from the Fastify server — no separate frontend needed.
 *
 * Routes:
 *   GET  /admin              — dashboard HTML
 *   GET  /admin/api/stats    — live stats (orders, revenue, alerts)
 *   GET  /admin/api/orders   — paginated order list
 *   POST /admin/api/orders/:id/approve   — approve a poster for printing
 *   POST /admin/api/orders/:id/fulfil    — mark as collected/fulfilled
 *   POST /admin/api/orders/:id/cancel    — cancel an order
 *
 * Authentication: simple username/password from .env
 * (Basic auth over HTTPS — good enough for a single-operator dashboard)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '@/utils/logger.js';
import { authenticate, authenticatePage, requireFullAdmin, type AdminRole } from '@/utils/auth.js';
import { db } from '@/db/client.js';
import { orders, orderItems, customers, printJobs, printers, webUsers, images, processedImages, slipJobs } from '@/db/schema.js';
import { getSignedImageUrl } from '@/services/image-storage.js';
import { releaseOrderForPickup, recordQboSaleForOrder } from '@/services/order.js';
import { approveCancellationAndRefund, declineCancellation } from '@/services/refund.js';
import { getDnpMediaMode, setDnpMediaMode, type DnpMediaMode } from '@/services/store-settings.js';
import { eq, desc, and, gte, sql, count, inArray } from 'drizzle-orm';

// ===== Auth middleware =====

/**
 * Backward-compatible wrapper around the shared authenticate() helper.
 * Returns the role string when authenticated, null otherwise (with 401
 * already set on reply).
 */
function checkAuth(request: FastifyRequest, reply: FastifyReply): AdminRole | null {
  return authenticate(request, reply);
}

// ===== Data helpers =====

async function getStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    pendingApproval,
    pendingPayment,
    queuedForPrint,
    readyForCollection,
    todayOrders,
    todayRevenue,
    totalOrders,
    pending5x7,
  ] = await Promise.all([
    // Orders awaiting poster approval
    db.select({ count: count() }).from(orders)
      .where(eq(orders.status, 'awaiting_approval')),
    // Orders awaiting payment
    db.select({ count: count() }).from(orders)
      .where(eq(orders.status, 'pending_payment')),
    // Orders queued for printing
    db.select({ count: count() }).from(orders)
      .where(eq(orders.status, 'queued_for_print')),
    // Orders ready for collection
    db.select({ count: count() }).from(orders)
      .where(eq(orders.status, 'ready_for_collection')),
    // Today's orders
    db.select({ count: count() }).from(orders)
      .where(gte(orders.createdAt, today)),
    // Today's revenue (paid orders only)
    db.select({ total: sql<string>`COALESCE(SUM(total_usd), 0)` }).from(orders)
      .where(and(gte(orders.createdAt, today), eq(orders.status, 'paid'))),
    // All time orders
    db.select({ count: count() }).from(orders),
    // Held 5×7 print jobs (queued, dye_sub_5x7) waiting for an operator media swap
    db.select({ count: count() }).from(printJobs)
      .where(and(eq(printJobs.status, 'queued'), eq(printJobs.targetPrinterType, 'dye_sub_5x7'))),
  ]);

  const dnpMediaMode = await getDnpMediaMode();

  return {
    pendingApproval: pendingApproval[0].count,
    pendingPayment: pendingPayment[0].count,
    queuedForPrint: queuedForPrint[0].count,
    readyForCollection: readyForCollection[0].count,
    todayOrders: todayOrders[0].count,
    todayRevenue: parseFloat(todayRevenue[0].total ?? '0').toFixed(2),
    totalOrders: totalOrders[0].count,
    pending5x7: pending5x7[0].count,
    dnpMediaMode,
  };
}

async function getOrders(filter?: string, limit = 50) {
  const baseQuery = db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalUsd: orders.totalUsd,
      fulfillmentMethod: orders.fulfillmentMethod,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
      readyAt: orders.readyAt,
      // WhatsApp orders carry a customer; web orders carry a web user instead.
      // Fall back through both so the name/phone show for either channel.
      customerName: sql<string | null>`COALESCE(${customers.name}, ${webUsers.displayName}, ${webUsers.email})`,
      customerPhone: sql<string | null>`COALESCE(${customers.phoneNumber}, ${orders.contactPhone}, ${webUsers.whatsappNumber})`,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(webUsers, eq(orders.webUserId, webUsers.id))
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  if (filter === 'today') {
    // Start of today in server timezone
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return baseQuery.where(gte(orders.createdAt, startOfToday));
  }

  if (filter && filter !== 'all') {
    return baseQuery.where(eq(orders.status, filter as typeof orders.status.enumValues[number]));
  }

  return baseQuery;
}

async function getOrderDetails(orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  // Resolve the buyer from whichever channel the order came in on: a WhatsApp
  // customer, or (for web orders) the web user. The detail view only reads
  // name + phoneNumber, so a web user is mapped onto that shape.
  let customer:
    | { name: string | null; phoneNumber: string | null }
    | undefined;
  if (order.customerId) {
    const [c] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, order.customerId))
      .limit(1);
    customer = c;
  } else if (order.webUserId) {
    const [wu] = await db
      .select()
      .from(webUsers)
      .where(eq(webUsers.id, order.webUserId))
      .limit(1);
    // Prefer the phone captured at checkout, fall back to the profile WhatsApp number.
    if (wu) customer = { name: wu.displayName ?? wu.email, phoneNumber: order.contactPhone ?? wu.whatsappNumber };
  }

  const rawItems = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  // Attach a signed preview URL per item so the operator can see what's printing:
  // the edited render if there is one, otherwise the original source image.
  const items = await Promise.all(
    rawItems.map(async (it) => {
      let previewUrl: string | null = null;
      try {
        if (it.processedImageId) {
          const [p] = await db
            .select({ key: processedImages.processedStorageKey })
            .from(processedImages)
            .where(eq(processedImages.id, it.processedImageId))
            .limit(1);
          if (p?.key) previewUrl = await getSignedImageUrl(p.key);
        }
        if (!previewUrl && it.imageId) {
          const [img] = await db
            .select({ key: images.storageKey })
            .from(images)
            .where(eq(images.id, it.imageId))
            .limit(1);
          if (img?.key) previewUrl = await getSignedImageUrl(img.key);
        }
      } catch {
        previewUrl = null; // never let a missing image break the detail view
      }
      return { ...it, previewUrl };
    }),
  );

  const jobs = await db
    .select({
      id: printJobs.id,
      status: printJobs.status,
      attempts: printJobs.attempts,
      errorMessage: printJobs.errorMessage,
      printerName: printers.name,
    })
    .from(printJobs)
    .leftJoin(printers, eq(printJobs.printerId, printers.id))
    .where(
      sql`${printJobs.orderItemId} IN (
        SELECT id FROM order_items WHERE order_id = ${orderId}
      )`,
    );

  // Slip cards — the branded/operational 4×6 prints that print with every order
  // (end_separator, order_info, promo). Each is a pre-rendered PNG on B2; sign a
  // thumbnail so the operator can eyeball exactly what printed. The thermal
  // envelope label (envelope_label) is ZPL with no image, so it's excluded here.
  const rawSlips = await db
    .select({
      id: slipJobs.id,
      slipType: slipJobs.slipType,
      status: slipJobs.status,
      sequencePosition: slipJobs.sequencePosition,
      printReadyFileUrl: slipJobs.printReadyFileUrl,
    })
    .from(slipJobs)
    .where(
      and(
        eq(slipJobs.orderId, orderId),
        sql`${slipJobs.slipType} <> 'envelope_label'`,
      ),
    )
    .orderBy(slipJobs.sequencePosition);

  const slips = await Promise.all(
    rawSlips.map(async (s) => {
      let previewUrl: string | null = null;
      try {
        if (s.printReadyFileUrl) {
          // Slip URLs are full B2 URLs; the storage key is the path component.
          const key = new URL(s.printReadyFileUrl).pathname.replace(/^\/+/, '');
          if (key) previewUrl = await getSignedImageUrl(key);
        }
      } catch {
        previewUrl = null; // never let a missing slip image break the detail view
      }
      return { ...s, previewUrl };
    }),
  );

  return { order, customer, items, jobs, slips };
}



// QBO + Payonify refunds for a cancelled paid order are handled in
// services/refund.ts (approveCancellationAndRefund), called from the cancel +
// approve-cancellation endpoints below. Sales receipts still post at
// markOrderPaid (services/order.ts postSalesReceiptForOrder).

// ===== Route registration =====

export async function registerAdminDashboard(app: FastifyInstance): Promise<void> {

  // Order Management is the default admin page. /admin redirects to it,
  // preserving any ?order= deep-link so the detail modal still opens.
  // (The standalone dashboard page was merged into Order Management's
  // Completed tab; its data + action APIs below are still used by the modal.)
  app.get('/admin', async (request, reply) => {
    const role = authenticatePage(request, reply);
    if (role === null) return;
    const orderId = (request.query as { order?: string }).order;
    reply.redirect(orderId ? `/admin/jobs?order=${encodeURIComponent(orderId)}` : '/admin/jobs');
  });

  // Stats API
  app.get('/admin/api/stats', async (request, reply) => {
    const role = checkAuth(request, reply);
    if (role === null) return;
    try {
      const stats = await getStats();
      // Operator role: strip revenue figure. The UI hides the card, but
      // we don't trust client-side hiding alone — the API also redacts.
      if (role === 'operator') {
        return { ...stats, todayRevenue: null };
      }
      return stats;
    } catch (err) {
      logger.error({ err }, 'Failed to get stats');
      return reply.status(500).send({ error: 'Failed to load stats' });
    }
  });

  // Orders list API
  app.get('/admin/api/orders', async (request, reply) => {
    const role = checkAuth(request, reply);
    if (role === null) return;
    try {
      // Accepts ?status= (legacy) or ?filter= (today/all/status name)
      const { filter, status } = request.query as { filter?: string; status?: string };
      const list = await getOrders(filter ?? status);
      if (role === 'operator') {
        // Strip the totalUsd field — operator doesn't see prices anywhere.
        return list.map(({ totalUsd: _totalUsd, ...rest }) => rest);
      }
      return list;
    } catch (err) {
      logger.error({ err }, 'Failed to get orders');
      return reply.status(500).send({ error: 'Failed to load orders' });
    }
  });

  // Order detail API
  app.get('/admin/api/orders/:id', async (request, reply) => {
    const role = checkAuth(request, reply);
    if (role === null) return;
    try {
      const { id } = request.params as { id: string };
      const detail = await getOrderDetails(id);
      if (!detail) {
        reply.status(404).send({ error: 'Order not found' });
        return;
      }
      if (role === 'operator') {
        // Strip dollar fields from order + items. Operator sees the
        // operational picture (status, items, jobs) but no prices.
        const { totalUsd: _t, deliveryFeeUsd: _d, ...orderRest } = detail.order;
        const items = detail.items.map(
          ({ unitPriceUsd: _u, lineTotalUsd: _l, ...itemRest }) => itemRest,
        );
        return { ...detail, order: orderRest, items };
      }
      return detail;
    } catch (err) {
      logger.error({ err }, 'Failed to get order detail');
      return reply.status(500).send({ error: 'Failed to load order' });
    }
  });

  // Approve poster for printing
  app.post('/admin/api/orders/:id/approve', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await db.update(orders)
        .set({ status: 'queued_for_print' })
        .where(eq(orders.id, id));
      // Only release the jobs that were awaiting approval — never re-queue jobs
      // that already printed (done) in a mixed order, or they'd reprint.
      await db.update(printJobs)
        .set({ status: 'queued' })
        .where(
          sql`${printJobs.orderItemId} IN (
            SELECT id FROM order_items WHERE order_id = ${id}
          ) AND ${printJobs.status} = 'awaiting_approval'`,
        );
      logger.info({ orderId: id }, 'Order approved for printing');
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to approve order');
      return reply.status(500).send({ error: 'Failed to approve' });
    }
  });

  // Phase D.3: Release for Pickup
  // Called when operator has physically collected all prints from printer trays,
  // placed them in the envelope with the label applied, and is ready to hand
  // them off to the customer. Advances status to ready_for_pickup AND sends
  // the customer a WhatsApp notification with pickup details.
  app.post('/admin/api/orders/:id/release-for-pickup', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };

      // Need the order_number to call releaseOrderForPickup (which works by order_number)
      const [order] = await db
        .select({ orderNumber: orders.orderNumber, status: orders.status })
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1);

      if (!order) {
        reply.status(404).send({ error: 'Order not found' });
        return;
      }

      // Only allow release from 'printed' or 'paid' status
      // (paid is for legacy orders that bypassed the printed step)
      if (order.status !== 'printed' && order.status !== 'paid') {
        reply.status(400).send({
          error: `Cannot release from status '${order.status}'. Order must be 'printed' or 'paid'.`,
        });
        return;
      }

      await releaseOrderForPickup(order.orderNumber);

      logger.info({ orderId: id, orderNumber: order.orderNumber }, 'Order released for pickup');
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to release order for pickup');
      return reply.status(500).send({ error: 'Failed to release' });
    }
  });

  // DNP media mode — operator toggle for the single DNP's loaded media.
  // Flipping to '5x7' releases the held 5×7 batch AND auto-pauses the 4×6 family
  // (the agent's job-serving endpoint only hands out jobs whose media matches the
  // current mode). Flip back to '6x8' to resume normal flow. After flipping, the
  // operator must physically load the matching media.
  app.get('/admin/api/dnp-media-mode', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    return { mode: await getDnpMediaMode() };
  });

  app.post('/admin/api/dnp-media-mode', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    const { mode } = (request.body ?? {}) as { mode?: string };
    if (mode !== '6x8' && mode !== '5x7') {
      reply.status(400).send({ error: "mode must be '6x8' or '5x7'" });
      return;
    }
    // No-op if already in that mode (don't run the guard for a non-switch).
    if ((await getDnpMediaMode()) === mode) {
      return { ok: true, mode };
    }
    // Guard: don't switch media while a dye-sub job is physically PRINTING on the
    // single DNP — swapping media mid-print ruins that print. Queued jobs are
    // safely held by the serve-time gate, so we only block on an in-flight job.
    const [printing] = await db
      .select({ id: printJobs.id })
      .from(printJobs)
      .where(and(eq(printJobs.status, 'printing'), inArray(printJobs.targetPrinterType, ['dye_sub_4x6', 'dye_sub_5x7'])))
      .limit(1);
    const [printingSlip] = await db
      .select({ id: slipJobs.id })
      .from(slipJobs)
      .where(and(eq(slipJobs.status, 'printing'), eq(slipJobs.targetPrinterType, 'dye_sub_4x6')))
      .limit(1);
    if (printing || printingSlip) {
      reply
        .status(409)
        .send({ error: 'A print is currently running on the DNP. Wait for it to finish before switching media.' });
      return;
    }
    await setDnpMediaMode(mode as DnpMediaMode);
    logger.info({ mode }, 'DNP media mode changed by operator');
    return { ok: true, mode };
  });

  // Mark as fulfilled (collected)
  app.post('/admin/api/orders/:id/fulfil', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await db.update(orders)
        .set({ status: 'fulfilled', fulfilledAt: new Date() })
        .where(eq(orders.id, id));
      logger.info({ orderId: id }, 'Order fulfilled');
      // Fallback QBO sale posting — the primary post happens at markOrderPaid.
      // Idempotent + self-guarded (settles the invoice or posts a receipt), so
      // this only catches orders whose paid-time post hadn't run and never
      // double-posts.
      void recordQboSaleForOrder(id).catch(err =>
        logger.error({ err, orderId: id }, 'QBO sale posting failed — manual entry needed')
      );
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to fulfil order');
      return reply.status(500).send({ error: 'Failed to update' });
    }
  });

  // Cancel order — full admin only (cancellation is a financial decision).
  // Paid orders go through the refund flow (Payonify refund + QBO receipt +
  // notify + stop pipeline jobs); unpaid orders just flip to cancelled.
  app.post('/admin/api/orders/:id/cancel', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const [order] = await db.select({ paidAt: orders.paidAt }).from(orders).where(eq(orders.id, id)).limit(1);
      if (!order) return reply.status(404).send({ error: 'not_found' });

      if (order.paidAt) {
        const result = await approveCancellationAndRefund(id);
        if (!result.ok) {
          return reply.status(502).send({ error: result.reason, message: refundErrorMessage(result.reason) });
        }
        logger.info({ orderId: id }, 'Paid order cancelled + refunded from dashboard');
        return { ok: true, refunded: true, refundReference: result.refundReference };
      }

      await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, id));
      logger.info({ orderId: id }, 'Unpaid order cancelled from dashboard');
      return { ok: true, refunded: false };
    } catch (err) {
      logger.error({ err }, 'Failed to cancel order');
      return reply.status(500).send({ error: 'Failed to cancel' });
    }
  });

  // Approve a customer's cancellation request → issue the refund. Full admin only.
  app.post('/admin/api/orders/:id/approve-cancellation', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const result = await approveCancellationAndRefund(id);
      if (!result.ok) {
        return reply.status(502).send({ error: result.reason, message: refundErrorMessage(result.reason) });
      }
      return { ok: true, refundReference: result.refundReference };
    } catch (err) {
      logger.error({ err }, 'Failed to approve cancellation');
      return reply.status(500).send({ error: 'Failed to approve' });
    }
  });

  // Decline a customer's cancellation request (order stays live). Full admin only.
  app.post('/admin/api/orders/:id/decline-cancellation', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const result = await declineCancellation(id);
      if (!result.ok) return reply.status(404).send({ error: result.reason });
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to decline cancellation');
      return reply.status(500).send({ error: 'Failed to decline' });
    }
  });
}

/** Human-readable message for a failed refund, surfaced in the admin modal. */
function refundErrorMessage(reason?: string): string {
  switch (reason) {
    case 'no_charge_reference':
      return 'No refundable charge on file for this order (e.g. an older or non-gateway payment). Refund manually in Payonify.';
    case 'no_payment':
      return 'No successful payment found for this order.';
    case 'gateway_error':
      return 'Payonify rejected the refund. The order was left intact — check Payonify and retry.';
    case 'not_paid':
      return 'This order was never paid, so there is nothing to refund.';
    default:
      return 'Could not issue the refund.';
  }
}
