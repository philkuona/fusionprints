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
import { isEnabled as qboEnabled, isSetupComplete, createSalesReceipt, createRefundReceipt } from '@/services/qbo.js';
import { payments } from '@/db/schema.js';
import { desc } from 'drizzle-orm';
import { logger } from '@/utils/logger.js';
import { authenticate, authenticatePage, requireFullAdmin, type AdminRole } from '@/utils/auth.js';
import { db } from '@/db/client.js';
import { orders, orderItems, customers, printJobs, printers, webUsers, images, processedImages, slipJobs } from '@/db/schema.js';
import { getSignedImageUrl } from '@/services/image-storage.js';
import { ADMIN_FONT_CSS } from '@/routes/admin-fonts.js';
import { eq, desc, and, gte, sql, count } from 'drizzle-orm';

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
  ]);

  return {
    pendingApproval: pendingApproval[0].count,
    pendingPayment: pendingPayment[0].count,
    queuedForPrint: queuedForPrint[0].count,
    readyForCollection: readyForCollection[0].count,
    todayOrders: todayOrders[0].count,
    todayRevenue: parseFloat(todayRevenue[0].total ?? '0').toFixed(2),
    totalOrders: totalOrders[0].count,
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

// ===== Dashboard HTML =====

function dashboardHtml(role: AdminRole = 'full'): string {
  const isOperator = role === 'operator';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FusionPrints Admin</title>
  <style>
    ${ADMIN_FONT_CSS}

    :root {
      --bg: #0a0a0a;
      --surface: #141414;
      --surface2: #1e1e1e;
      --border: #2a2a2a;
      --text: #f0f0f0;
      --text2: #888;
      --accent: #f97316;
      --accent2: #fb923c;
      --green: #22c55e;
      --yellow: #eab308;
      --red: #ef4444;
      --blue: #3b82f6;
      --radius: 8px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 14px;
    }

    /* Header */
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .logo {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .logo svg { display: block; height: 36px; width: auto; }

    .logo .admin-tag {
      font-family: 'DM Mono', monospace;
      font-size: 10px;
      font-weight: 500;
      color: var(--text2);
      text-transform: uppercase;
      letter-spacing: 1px;
      padding: 2px 6px;
      border: 1px solid var(--border);
      border-radius: 3px;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .live-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text2);
    }

    .nav-tabs {
      display: flex;
      gap: 2px;
      flex: 1;
      margin-left: 24px;
    }

    .nav-tab {
      padding: 8px 14px;
      color: var(--text2);
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      border-radius: 6px;
      transition: all 0.15s;
    }

    .nav-tab:hover { color: var(--text); background: var(--surface); }
    .nav-tab.active { color: var(--accent); background: var(--surface); }

    .live-dot {
      width: 6px;
      height: 6px;
      background: var(--green);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* Layout */
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }

    /* Alert banner */
    #alert-banner {
      display: none;
      background: #7c2d12;
      border: 1px solid #9a3412;
      border-radius: var(--radius);
      padding: 12px 16px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #fed7aa;
    }

    /* Stats grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      cursor: pointer;
      transition: border-color 0.15s;
    }

    .stat-card:hover { border-color: var(--accent); }
    .stat-card.alert { border-color: var(--red); }
    .stat-card.active { border-color: var(--accent); background: #1a1200; }

    .stat-label {
      font-size: 11px;
      color: var(--text2);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .stat-value {
      font-family: 'DM Mono', monospace;
      font-size: 28px;
      font-weight: 500;
      line-height: 1;
    }

    .stat-value.red { color: var(--red); }
    .stat-value.yellow { color: var(--yellow); }
    .stat-value.green { color: var(--green); }
    .stat-value.orange { color: var(--accent); }
    .stat-value.blue { color: var(--blue); }

    /* Filter tabs */
    .filters {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .filter-btn {
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text2);
      font-size: 12px;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      transition: all 0.15s;
    }

    .filter-btn:hover { border-color: var(--accent); color: var(--text); }
    .filter-btn.active { background: var(--accent); border-color: var(--accent); color: white; }

    /* Orders table */
    .orders-container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .orders-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .orders-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }

    .orders-count {
      font-size: 12px;
      color: var(--text2);
      font-family: 'DM Mono', monospace;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      text-align: left;
      padding: 10px 16px;
      font-size: 11px;
      color: var(--text2);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
      font-weight: 500;
    }

    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    tr:last-child td { border-bottom: none; }

    tr:hover td { background: var(--surface2); }

    .order-number {
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      color: var(--accent);
    }

    .customer-name { font-weight: 500; }
    .customer-phone { font-size: 12px; color: var(--text2); }

    /* Status badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }

    .badge-pending_payment { background: #1c1917; color: #a8a29e; border: 1px solid #292524; }
    .badge-paid { background: #052e16; color: #86efac; border: 1px solid #14532d; }
    .badge-awaiting_approval { background: #431407; color: #fdba74; border: 1px solid #7c2d12; }
    .badge-queued_for_print { background: #1e3a5f; color: #93c5fd; border: 1px solid #1d4ed8; }
    .badge-printing { background: #1e3a5f; color: #60a5fa; border: 1px solid #2563eb; }
    .badge-printed { background: #422006; color: #fbbf24; border: 1px solid #92400e; }
    .badge-ready_for_pickup { background: #052e16; color: #4ade80; border: 1px solid #16a34a; }
    .badge-ready_for_collection { background: #052e16; color: #4ade80; border: 1px solid #16a34a; }
    .badge-fulfilled { background: #141414; color: #6b7280; border: 1px solid #374151; }
    .badge-cancelled { background: #141414; color: #6b7280; border: 1px solid #374151; }
    .badge-failed { background: #450a0a; color: #f87171; border: 1px solid #991b1b; }

    .amount {
      font-family: 'DM Mono', monospace;
      font-size: 13px;
    }

    .fulfillment-icon { font-size: 16px; }

    /* Action buttons */
    .action-btn {
      padding: 5px 10px;
      border-radius: 5px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      font-size: 11px;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      transition: all 0.15s;
      margin-right: 4px;
    }

    .action-btn:hover { background: var(--surface2); }
    .action-btn.approve { border-color: var(--green); color: var(--green); }
    .action-btn.approve:hover { background: #052e16; }
    .action-btn.ready { border-color: var(--blue); color: var(--blue); }
    .action-btn.ready:hover { background: #1e3a5f; }
    .action-btn.fulfil { border-color: var(--text2); color: var(--text2); }
    .action-btn.cancel { border-color: var(--red); color: var(--red); }
    .action-btn.cancel:hover { background: #450a0a; }

    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      z-index: 200;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .modal-overlay.open { display: flex; }

    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 100%;
      max-width: 560px;
      max-height: 80vh;
      overflow-y: auto;
    }

    .modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-title {
      font-weight: 600;
      font-family: 'DM Mono', monospace;
      color: var(--accent);
    }

    .modal-close {
      background: none;
      border: none;
      color: var(--text2);
      cursor: pointer;
      font-size: 20px;
      padding: 0 4px;
    }

    .modal-body { padding: 20px; }

    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }

    .detail-row:last-child { border-bottom: none; }
    .detail-label { color: var(--text2); }
    .detail-value { font-weight: 500; text-align: right; }

    .items-list { margin-top: 16px; }
    .items-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text2);
      margin-bottom: 8px;
    }

    .item-row {
      background: var(--surface2);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
    }

    /* Time */
    .time-ago { font-size: 11px; color: var(--text2); }

    /* Loading */
    .loading {
      text-align: center;
      padding: 40px;
      color: var(--text2);
      font-size: 13px;
    }

    /* Empty state */
    .empty {
      text-align: center;
      padding: 40px;
      color: var(--text2);
      font-size: 13px;
    }

    /* Refresh button */
    .refresh-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--text2);
      padding: 6px 12px;
      border-radius: var(--radius);
      cursor: pointer;
      font-size: 12px;
      font-family: 'DM Sans', sans-serif;
      transition: all 0.15s;
    }

    .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }

    @media (max-width: 768px) {
      header { padding: 10px 14px; flex-wrap: wrap; gap: 8px; }
      .nav-tabs { order: 3; width: 100%; margin-left: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 2px; flex-wrap: nowrap; }
      .nav-tab { white-space: nowrap; font-size: 12px; padding: 6px 10px; }
      .header-right { order: 2; }
      .live-indicator span { display: none; }
      main { padding: 12px; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .stat-value { font-size: 22px; }
      table th:nth-child(4), table td:nth-child(4),
      table th:nth-child(5), table td:nth-child(5) { display: none; }
      .action-btn { padding: 4px 7px; font-size: 10px; margin-right: 2px; }
      .modal-overlay { padding: 0; align-items: flex-end; }
      .modal { max-width: 100%; max-height: 92vh; border-radius: 12px 12px 0 0; }
      .filters { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 4px; }
      .filter-btn { white-space: nowrap; }
      .orders-container { overflow-x: auto; }
      table { min-width: 500px; }
    }

    .hamburger {
      display: none;
      background: none;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    .mobile-nav {
      display: none;
      position: fixed;
      top: 57px;
      left: 0;
      right: 0;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      z-index: 99;
      padding: 8px 0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .mobile-nav.open { display: block; }
    .mobile-nav a {
      display: block;
      padding: 13px 20px;
      color: var(--text2);
      text-decoration: none;
      font-size: 15px;
      font-weight: 500;
      border-bottom: 1px solid var(--border);
      transition: background 0.1s;
    }
    .mobile-nav a:last-child { border-bottom: none; }
    .mobile-nav a:hover, .mobile-nav a.active {
      background: var(--surface2);
      color: var(--accent);
    }
    @media (max-width: 768px) {
      .nav-tabs { display: none !important; }
      .hamburger { display: block; }
      .live-indicator span { display: none; }
      header { padding: 10px 14px; }
      main { padding: 12px; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .stat-value { font-size: 22px; }
      .action-btn { padding: 4px 7px; font-size: 10px; margin-right: 2px; }
      .modal-overlay { padding: 0; align-items: flex-end; }
      .modal { max-width: 100%; max-height: 92vh; border-radius: 12px 12px 0 0; }
      .filters { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 4px; }
      .filter-btn { white-space: nowrap; }
      .orders-container { overflow-x: auto; }
      table { min-width: 500px; }
      table th:nth-child(4), table td:nth-child(4),
      table th:nth-child(5), table td:nth-child(5) { display: none; }
    }
  </style>
</head>
<body>

<header>
  <div class="logo">
    <svg viewBox="0 0 280 60" xmlns="http://www.w3.org/2000/svg" aria-label="FusionPrints">
      <g transform="translate(0,6)">
        <path d="M0 8 L12 0 L40 0 L40 14 L26 14 L14 22 L14 48 L0 48 Z" fill="#FBF7F0"/>
        <path d="M14 22 L26 14 L40 14 L40 28 Z" fill="#05D668"/>
      </g>
      <text x="56" y="40" font-family="Outfit, system-ui, -apple-system, sans-serif" font-size="28" font-weight="700" fill="#FBF7F0" letter-spacing="-0.56">fusionprints</text>
    </svg>
    <span class="admin-tag">${isOperator ? 'operator' : 'admin'}</span>
  </div>
  <nav class="nav-tabs">
    <a href="/admin/jobs" class="nav-tab">Order Management</a>
    <a href="/admin" class="nav-tab active">Dashboard</a>
    <a href="/admin/printers" class="nav-tab">Printers</a>
    ${isOperator ? '' : '<a href="/admin/metrics" class="nav-tab">Key Metrics</a>'}
    ${isOperator ? '' : '<a href="/admin/promos" class="nav-tab">Promos</a>'}
    ${isOperator ? '' : '<a href="/admin/pricing" class="nav-tab">Pricing</a>'}
    ${isOperator ? '' : '<a href="/admin/qbo" class="nav-tab">QuickBooks</a>'}
  </nav>
  <div class="header-right">
    <div class="live-indicator">
      <div class="live-dot"></div>
      <span id="last-updated">loading...</span>
    </div>
    <button class="refresh-btn" onclick="loadAll()">↻ Refresh</button>
  </div>
<button class="hamburger" id="hamburger-btn" onclick="toggleMobileNav()">&#9776;</button>
</header>
<div class="mobile-nav" id="mobile-nav">
  <a href="/admin/jobs">Order Management</a>
  <a href="/admin" class="active">Dashboard</a>
  <a href="/admin/printers">Printers</a>
  <a href="/admin/metrics">Key Metrics</a>
  <a href="/admin/promos">Promos</a>
  <a href="/admin/pricing">Pricing</a>
  <a href="/admin/qbo">QuickBooks</a>
</div>
<script>
  function toggleMobileNav() {
    document.getElementById('mobile-nav').classList.toggle('open');
  }
  document.addEventListener('click', function(e) {
    var nav = document.getElementById('mobile-nav');
    var btn = document.getElementById('hamburger-btn');
    if (nav && btn && !nav.contains(e.target) && !btn.contains(e.target)) {
      nav.classList.remove('open');
    }
  });
</script>

<main>
  <div id="alert-banner"></div>

  <!-- Stats -->
  <div class="stats-grid" id="stats-grid">
    <div class="loading">Loading stats...</div>
  </div>

  <!-- Filters -->
  <div class="filters">
    <button class="filter-btn active" onclick="setFilter(this, 'today')">Today</button>
    <button class="filter-btn" onclick="setFilter(this, 'all')">All orders</button>
    <button class="filter-btn" onclick="setFilter(this, 'awaiting_approval')">⚠️ Needs approval</button>
    <button class="filter-btn" onclick="setFilter(this, 'paid')">Paid</button>
    <button class="filter-btn" onclick="setFilter(this, 'queued_for_print')">In queue</button>
    <button class="filter-btn" onclick="setFilter(this, 'ready_for_collection')">Ready</button>
    <button class="filter-btn" onclick="setFilter(this, 'pending_payment')">Pending payment</button>
    <button class="filter-btn" onclick="setFilter(this, 'fulfilled')">Fulfilled</button>
  </div>

  <!-- Orders table -->
  <div class="orders-container">
    <div class="orders-header">
      <span class="orders-title">Completed Orders</span>
      <span class="orders-count" id="order-count">—</span>
    </div>
    <div id="orders-body">
      <div class="loading">Loading orders...</div>
    </div>
  </div>
</main>

<!-- Order detail modal -->
<div class="modal-overlay" id="modal-overlay" onclick="closeModal(event)">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title" id="modal-title">Order</span>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body" id="modal-body">Loading...</div>
  </div>
</div>

<script>
  const VIEWER_ROLE = ${JSON.stringify(role)};
  const IS_OPERATOR = VIEWER_ROLE === 'operator';
  let currentFilter = 'today';
  let refreshTimer;

  function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    const diff = Math.floor((Date.now() - date) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    return Math.floor(diff/86400) + 'd ago';
  }

  function statusLabel(status) {
    const labels = {
      pending_payment: 'Pending payment',
      paid: 'Paid',
      awaiting_approval: 'Needs approval',
      queued_for_print: 'In queue',
      printing: 'Printing',
      printed: 'Printed (release?)',
      ready_for_pickup: 'Ready for pickup',
      ready_for_collection: 'Ready',
      fulfilled: 'Fulfilled',
      cancelled: 'Cancelled',
      failed: 'Failed',
    };
    return labels[status] || status;
  }

  function actionButtons(order) {
    const btns = [];
    if (order.status === 'awaiting_approval') {
      btns.push(\`<button class="action-btn approve" onclick="doAction('\${order.id}', 'approve', event)">✓ Approve</button>\`);
    }
    if (order.status === 'printed') {
      btns.push(\`<button class="action-btn approve" onclick="doAction('\${order.id}', 'release-for-pickup', event)">📦 Release</button>\`);
    }
    if (order.status === 'ready_for_collection' || order.status === 'ready_for_pickup') {
      btns.push(\`<button class="action-btn fulfil" onclick="doAction('\${order.id}', 'fulfil', event)">Collected</button>\`);
    }
    if (!IS_OPERATOR && !['fulfilled', 'cancelled', 'failed'].includes(order.status)) {
      btns.push(\`<button class="action-btn cancel" onclick="doAction('\${order.id}', 'cancel', event)">✕</button>\`);
    }
    return btns.join('');
  }

  async function loadStats() {
    const res = await fetch('/admin/api/stats');
    const stats = await res.json();

    // Show alert if anything needs attention
    const alertBanner = document.getElementById('alert-banner');
    if (stats.pendingApproval > 0) {
      alertBanner.style.display = 'block';
      alertBanner.textContent = \`⚠️ \${stats.pendingApproval} poster order\${stats.pendingApproval > 1 ? 's' : ''} waiting for your approval.\`;
    } else {
      alertBanner.style.display = 'none';
    }

    document.getElementById('stats-grid').innerHTML = \`
      <div class="stat-card \${stats.pendingApproval > 0 ? 'alert' : ''}" onclick="setFilterByClick('awaiting_approval')">
        <div class="stat-label">Needs approval</div>
        <div class="stat-value \${stats.pendingApproval > 0 ? 'red' : ''}">\${stats.pendingApproval}</div>
      </div>
      <div class="stat-card" onclick="setFilterByClick('ready_for_collection')">
        <div class="stat-label">Ready to collect</div>
        <div class="stat-value blue">\${stats.readyForCollection}</div>
      </div>
      <div class="stat-card" onclick="setFilterByClick('queued_for_print')">
        <div class="stat-label">In print queue</div>
        <div class="stat-value yellow">\${stats.queuedForPrint}</div>
      </div>
      <div class="stat-card" onclick="setFilterByClick('pending_payment')">
        <div class="stat-label">Pending payment</div>
        <div class="stat-value">\${stats.pendingPayment}</div>
      </div>
      <div class="stat-card" onclick="setFilterByClick('today')">
        <div class="stat-label">Today's orders</div>
        <div class="stat-value orange">\${stats.todayOrders}</div>
      </div>
      \${IS_OPERATOR ? '' : \`<div class="stat-card" onclick="setFilterByClick('today')">
        <div class="stat-label">Today's revenue</div>
        <div class="stat-value green">$\${stats.todayRevenue}</div>
      </div>\`}
    \`;
  }

  async function loadOrders() {
    const url = (currentFilter && currentFilter !== 'all')
      ? \`/admin/api/orders?filter=\${currentFilter}\`
      : '/admin/api/orders?filter=all';
    const res = await fetch(url);
    const orderList = await res.json();

    document.getElementById('order-count').textContent = \`\${orderList.length} orders\`;

    if (orderList.length === 0) {
      document.getElementById('orders-body').innerHTML =
        '<div class="empty">No orders found.</div>';
      return;
    }

    const rows = orderList.map(o => \`
      <tr onclick="showOrder('\${o.id}')" style="cursor:pointer">
        <td><span class="order-number">\${o.orderNumber}</span></td>
        <td>
          <div class="customer-name">\${o.customerName || 'Unknown'}</div>
          <div class="customer-phone">\${o.customerPhone || ''}</div>
        </td>
        <td><span class="badge badge-\${o.status}">\${statusLabel(o.status)}</span></td>
        \${IS_OPERATOR ? '' : \`<td><span class="amount">$\${parseFloat(o.totalUsd).toFixed(2)}</span></td>\`}
        <td><span class="fulfillment-icon">\${o.fulfillmentMethod === 'collection' ? '🏪' : '🚚'}</span></td>
        <td><span class="time-ago">\${timeAgo(o.createdAt)}</span></td>
        <td onclick="event.stopPropagation()">\${actionButtons(o)}</td>
      </tr>
    \`).join('');

    document.getElementById('orders-body').innerHTML = \`
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Status</th>
            \${IS_OPERATOR ? '' : '<th>Amount</th>'}
            <th>Type</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>\${rows}</tbody>
      </table>
    \`;
  }

  async function showOrder(orderId) {
    document.getElementById('modal-overlay').classList.add('open');
    document.getElementById('modal-body').innerHTML = '<div class="loading">Loading...</div>';

    const res = await fetch(\`/admin/api/orders/\${orderId}\`);
    const data = await res.json();

    if (!data) {
      document.getElementById('modal-body').innerHTML = '<div class="empty">Order not found.</div>';
      return;
    }

    const { order, customer, items, jobs, slips } = data;
    document.getElementById('modal-title').textContent = order.orderNumber;

    const slipLabels = { end_separator: 'Separator', order_info: 'Order info', promo: 'Promo card' };
    const slipsHtml = (slips || []).map(s => \`
      <div class="item-row">
        <span style="display:flex;align-items:center;gap:10px;">
          \${s.previewUrl
            ? \`<a href="\${s.previewUrl}" target="_blank" rel="noopener"><img src="\${s.previewUrl}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:4px;background:var(--surface);" /></a>\`
            : '<span style="width:44px;height:44px;border-radius:4px;background:var(--surface);display:inline-flex;align-items:center;justify-content:center;font-size:18px;opacity:0.4;">🪪</span>'}
          <span>\${slipLabels[s.slipType] || s.slipType}</span>
        </span>
        <span class="badge badge-\${s.status}">\${s.status}</span>
      </div>
    \`).join('');

    const itemsHtml = items.map(item => \`
      <div class="item-row">
        <span style="display:flex;align-items:center;gap:10px;">
          \${item.previewUrl
            ? \`<a href="\${item.previewUrl}" target="_blank" rel="noopener"><img src="\${item.previewUrl}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:4px;background:var(--surface);" /></a>\`
            : '<span style="width:44px;height:44px;border-radius:4px;background:var(--surface);display:inline-flex;align-items:center;justify-content:center;font-size:18px;opacity:0.4;">🖼</span>'}
          <span>\${item.quantity} × \${item.sizeCode} (\${item.productType.replace('_', ' ')})</span>
        </span>
        \${IS_OPERATOR ? '' : \`<span>$\${parseFloat(item.lineTotalUsd).toFixed(2)}</span>\`}
      </div>
    \`).join('');

    document.getElementById('modal-body').innerHTML = \`
      <div class="detail-row">
        <span class="detail-label">Customer</span>
        <span class="detail-value">\${customer?.name || 'Unknown'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Phone</span>
        <span class="detail-value">\${customer?.phoneNumber || '—'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Status</span>
        <span class="detail-value"><span class="badge badge-\${order.status}">\${statusLabel(order.status)}</span></span>
      </div>
      \${IS_OPERATOR ? '' : \`<div class="detail-row">
        <span class="detail-label">Total</span>
        <span class="detail-value">$\${parseFloat(order.totalUsd).toFixed(2)}</span>
      </div>\`}
      <div class="detail-row">
        <span class="detail-label">Fulfillment</span>
        <span class="detail-value">\${order.fulfillmentMethod === 'collection' ? '🏪 Collection' : '🚚 Delivery'}</span>
      </div>
      \${order.deliveryAddress ? \`
      <div class="detail-row">
        <span class="detail-label">Address</span>
        <span class="detail-value">\${order.deliveryAddress}</span>
      </div>\` : ''}
      <div class="detail-row">
        <span class="detail-label">Ordered</span>
        <span class="detail-value">\${new Date(order.createdAt).toLocaleString()}</span>
      </div>
      \${order.paidAt ? \`<div class="detail-row">
        <span class="detail-label">Paid</span>
        <span class="detail-value">\${new Date(order.paidAt).toLocaleString()}</span>
      </div>\` : ''}

      <div class="items-list">
        <div class="items-title">Items (\${items.length})</div>
        \${itemsHtml}
      </div>

      \${jobs.length > 0 ? \`
      <div class="items-list" style="margin-top:16px">
        <div class="items-title">Print jobs</div>
        \${jobs.map(j => \`
          <div class="item-row">
            <span>\${j.printerName || 'Unassigned'}</span>
            <span style="display:flex;gap:8px;align-items:center;">
              <span class="badge badge-\${j.status}">\${j.status}</span>
              \${j.status === 'failed' ? \`<button class="action-btn approve" style="padding:3px 8px;font-size:11px" onclick="reprintJob('\${j.id}')">↻ Reprint</button>\` : ''}
            </span>
          </div>
        \`).join('')}
      </div>\` : ''}

      \${(slips && slips.length > 0) ? \`
      <div class="items-list" style="margin-top:16px">
        <div class="items-title">Slip cards (\${slips.length})</div>
        \${slipsHtml}
      </div>\` : ''}

      <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
        \${order.status === 'awaiting_approval' ? \`<button class="action-btn approve" onclick="doAction('\${order.id}', 'approve'); closeModal()">✓ Approve for printing</button>\` : ''}
        \${order.status === 'printed' ? \`<button class="action-btn approve" onclick="doAction('\${order.id}', 'release-for-pickup'); closeModal()">📦 Release for pickup</button>\` : ''}
        \${order.status === 'ready_for_collection' && order.fulfillmentMethod === 'delivery' ? \`<button class="action-btn ready" onclick="doOpsAction('\${order.id}', 'shipped'); closeModal()">📦 Mark shipped</button>\` : ''}
        \${(order.status === 'ready_for_collection' || order.status === 'ready_for_pickup' || order.status === 'shipped') ? \`<button class="action-btn fulfil" onclick="doAction('\${order.id}', 'fulfil'); closeModal()">✓ Mark fulfilled</button>\` : ''}
        \${jobs.some(j => j.status === 'failed') ? \`<button class="action-btn approve" onclick="reprintOrder('\${order.id}')">↻ Reprint failed jobs</button>\` : ''}
        <button class="action-btn ready" onclick="previewReceipt('\${order.id}')">📄 Receipt</button>
        \${(!IS_OPERATOR && !['fulfilled','cancelled','failed'].includes(order.status)) ? \`<button class="action-btn cancel" onclick="doAction('\${order.id}', 'cancel'); closeModal()">Cancel order</button>\` : ''}
      </div>
    \`;
  }

  async function doOpsAction(orderId, action) {
    try {
      const r = await fetch('/admin/api/ops/orders/' + orderId + '/' + action, { method: 'POST' });
      if (!r.ok) throw new Error();
      loadAll();
    } catch (e) {
      alert('Action failed');
    }
  }

  async function reprintJob(jobId) {
    if (!confirm('Requeue this print job?')) return;
    try {
      const r = await fetch('/admin/api/ops/jobs/' + jobId + '/reprint', { method: 'POST' });
      if (!r.ok) throw new Error();
      alert('Job requeued. The agent will pick it up on next poll.');
      closeModal();
      loadAll();
    } catch (e) {
      alert('Reprint failed');
    }
  }

  async function reprintOrder(orderId) {
    if (!confirm('Requeue all failed jobs in this order?')) return;
    try {
      const r = await fetch('/admin/api/ops/orders/' + orderId + '/reprint', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error();
      alert('Requeued ' + data.count + ' job(s). The agent will pick them up.');
      closeModal();
      loadAll();
    } catch (e) {
      alert('Reprint failed');
    }
  }

  async function previewReceipt(orderId) {
    try {
      const r = await fetch('/admin/api/ops/orders/' + orderId + '/receipt-preview');
      const data = await r.json();
      if (!r.ok) throw new Error();
      const send = confirm('Receipt preview:\\n\\n' + data.text + '\\n\\n\\nSend this to the customer via WhatsApp?');
      if (send) {
        const r2 = await fetch('/admin/api/ops/orders/' + orderId + '/send-receipt', { method: 'POST' });
        const data2 = await r2.json();
        if (data2.ok) {
          alert('Receipt sent ✓');
        } else {
          alert('Failed to send receipt');
        }
      }
    } catch (e) {
      alert('Failed to preview receipt');
    }
  }

  async function doAction(orderId, action, event) {
    if (event) event.stopPropagation();
    if (action === 'cancel' && !confirm('Cancel this order?')) return;

    await fetch(\`/admin/api/orders/\${orderId}/\${action}\`, { method: 'POST' });
    loadAll();
  }

  function setFilter(btn, status) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = status;
    loadOrders();
  }

  function setFilterByClick(status) {
    const btns = document.querySelectorAll('.filter-btn');
    btns.forEach(b => {
      if (b.onclick && b.onclick.toString().includes(status)) {
        setFilter(b, status);
      }
    });
  }

  function closeModal(event) {
    if (event && event.target !== document.getElementById('modal-overlay')) return;
    document.getElementById('modal-overlay').classList.remove('open');
  }

  async function loadAll() {
    await Promise.all([loadStats(), loadOrders()]);
    document.getElementById('last-updated').textContent =
      'Updated ' + new Date().toLocaleTimeString();
  }

  // Auto-refresh every 30 seconds
  loadAll();
  refreshTimer = setInterval(loadAll, 30000);

  // Deep-link: /admin?order=ID opens that order's detail (from Order Management).
  (function () {
    const id = new URLSearchParams(location.search).get('order');
    if (id) showOrder(id);
  })();
</script>
</body>
</html>`;
}


// ===== QBO hook helpers =====

async function postQboSalesReceipt(orderId: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const [payment] = await db
    .select({ paymentMethod: payments.paymentMethod })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.completedAt))
    .limit(1);
  await createSalesReceipt(
    {
      orderNumber:    order.orderNumber,
      subtotalUsd:    order.subtotalUsd,
      deliveryFeeUsd: order.deliveryFeeUsd,
      totalUsd:       order.totalUsd,
      fulfilledAt:    order.fulfilledAt,
      createdAt:      order.createdAt,
    },
    items.map(i => ({
      sizeCode:     i.sizeCode,
      quantity:     i.quantity,
      unitPriceUsd: i.unitPriceUsd,
      lineTotalUsd: i.lineTotalUsd,
      productType:  i.productType,
    })),
    payment?.paymentMethod ?? null,
  );
}

async function postQboRefundIfPaid(orderId: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || !order.paidAt) return; // only refund if order was actually paid
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const [payment] = await db
    .select({ paymentMethod: payments.paymentMethod })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.completedAt))
    .limit(1);
  await createRefundReceipt(
    {
      orderNumber:    order.orderNumber,
      subtotalUsd:    order.subtotalUsd,
      deliveryFeeUsd: order.deliveryFeeUsd,
      totalUsd:       order.totalUsd,
      fulfilledAt:    order.fulfilledAt,
      createdAt:      order.createdAt,
    },
    items.map(i => ({
      sizeCode:     i.sizeCode,
      quantity:     i.quantity,
      unitPriceUsd: i.unitPriceUsd,
      lineTotalUsd: i.lineTotalUsd,
      productType:  i.productType,
    })),
    payment?.paymentMethod ?? null,
  );
}

// ===== Route registration =====

export async function registerAdminDashboard(app: FastifyInstance): Promise<void> {

  // Serve the dashboard HTML
  app.get('/admin', async (request, reply) => {
    const role = authenticatePage(request, reply);
    if (role === null) return;
    reply.type('text/html').send(dashboardHtml(role));
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
      reply.status(500).send({ error: 'Failed to load stats' });
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
      reply.status(500).send({ error: 'Failed to load orders' });
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
      reply.status(500).send({ error: 'Failed to load order' });
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
      await db.update(printJobs)
        .set({ status: 'queued' })
        .where(
          sql`${printJobs.orderItemId} IN (
            SELECT id FROM order_items WHERE order_id = ${id}
          )`,
        );
      logger.info({ orderId: id }, 'Order approved for printing');
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to approve order');
      reply.status(500).send({ error: 'Failed to approve' });
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

      const { releaseOrderForPickup } = await import('@/services/order.js');
      await releaseOrderForPickup(order.orderNumber);

      logger.info({ orderId: id, orderNumber: order.orderNumber }, 'Order released for pickup');
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to release order for pickup');
      reply.status(500).send({ error: 'Failed to release' });
    }
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
      // Fire-and-forget QBO Sales Receipt
      if (qboEnabled() && isSetupComplete()) {
        void postQboSalesReceipt(id).catch(err =>
          logger.error({ err, orderId: id }, 'QBO Sales Receipt failed — manual entry needed')
        );
      }
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to fulfil order');
      reply.status(500).send({ error: 'Failed to update' });
    }
  });

  // Cancel order — full admin only (cancellation is a financial decision)
  app.post('/admin/api/orders/:id/cancel', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await db.update(orders)
        .set({ status: 'cancelled' })
        .where(eq(orders.id, id));
      logger.info({ orderId: id }, 'Order cancelled from dashboard');
      // Fire-and-forget QBO Refund Receipt (only if order was paid)
      if (qboEnabled() && isSetupComplete()) {
        void postQboRefundIfPaid(id).catch(err =>
          logger.error({ err, orderId: id }, 'QBO Refund Receipt failed — manual entry needed')
        );
      }
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to cancel order');
      reply.status(500).send({ error: 'Failed to cancel' });
    }
  });
}
