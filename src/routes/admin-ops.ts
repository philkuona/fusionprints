/**
 * Admin Operations Routes
 *
 * Adds operational capabilities on top of the existing admin dashboard:
 *   - Order status transitions (mark shipped, mark collected)
 *   - Reprint failed jobs (per-job and per-order)
 *   - Receipt generation and WhatsApp delivery
 *   - Printer status panel
 *   - Service health and restart triggers
 *   - Metrics dashboard data
 *
 * All routes are mounted under /admin/api/ops/* and require auth via the
 * same checkAuth helper used by admin-dashboard.ts.
 *
 * Mount this AFTER registerAdminDashboard so the auth middleware applies.
 */

import type { FastifyInstance } from 'fastify';
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
  siteVisits,
  waitlist,
} from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { env } from '@/config/env.js';
import { authenticate, authenticatePage, requireFullAdmin, requireFullAdminPage, type AdminRole } from '@/utils/auth.js';

// Reuse the auth helper from admin-dashboard.ts
/**
 * Backward-compatible wrapper around the shared authenticate() helper.
 * Returns the role string when authenticated, null otherwise (with 401
 * already set on reply).
 */
function checkAuth(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): AdminRole | null {
  return authenticate(request, reply);
}

// ===== Order status transitions =====

/**
 * Mark an order as shipped (only valid for delivery orders).
 * This is a state transition that updates the timestamp and triggers a
 * customer notification.
 */
async function markShipped(orderId: string): Promise<void> {
  await db
    .update(orders)
    .set({ status: 'shipped', shippedAt: new Date() })
    .where(eq(orders.id, orderId));
  logger.info({ orderId }, 'Order marked shipped');
}

// ===== Reprint logic =====

/**
 * Reprint a single failed print job.
 * Resets status to queued so the agent picks it up on next poll.
 */
async function reprintJob(jobId: string): Promise<void> {
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
async function reprintOrder(orderId: string): Promise<number> {
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

// ===== Printer status =====

interface PrinterStatusInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  lastHeartbeat: Date | null;
  staleness: 'online' | 'stale' | 'offline';
  mediaRemaining: number | null;
  errorMessage: string | null;
}

async function getPrinterStatus(): Promise<PrinterStatusInfo[]> {
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
      status: p.status,
      lastHeartbeat: p.lastHeartbeatAt,
      staleness,
      mediaRemaining: null, // not tracked in current schema
      errorMessage: null,
    };
  });
}

// ===== Metrics =====

async function getDashboardMetrics(daysBack = 30) {
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

  // Print volume by size
  const sizeBreakdown = await db
    .select({
      sizeCode: orderItems.sizeCode,
      totalPrints: sql<string>`SUM(${orderItems.quantity})::text`,
      revenue: sql<string>`SUM(${orderItems.lineTotalUsd})::text`,
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

  return {
    daysBack,
    revenue: {
      totalUsd: parseFloat(revenue?.totalRevenue ?? '0'),
      orderCount: parseInt(revenue?.orderCount ?? '0', 10),
      avgOrderValue: parseFloat(revenue?.avgOrderValue ?? '0'),
    },
    statusBreakdown: statusBreakdown.map((r) => ({
      status: r.status,
      count: parseInt(r.count, 10),
    })),
    sizeBreakdown: sizeBreakdown.map((r) => ({
      sizeCode: r.sizeCode,
      totalPrints: parseInt(r.totalPrints, 10),
      revenue: parseFloat(r.revenue),
    })),
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
async function generateReceiptText(orderId: string): Promise<string | null> {
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
    lines.push(`  • ${item.quantity} × ${item.displayLabel} — $${total.toFixed(2)}`);
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
 * Send a receipt to the customer via WhatsApp.
 * Returns true on success, false on failure.
 */
async function sendReceiptViaWhatsApp(orderId: string): Promise<boolean> {
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

// ===== Restart agent (reset stuck jobs) =====

/**
 * Reset stuck jobs that have been "printing" for too long.
 * If the agent crashed mid-job, the database thinks the job is still printing.
 * This gives admins a one-click way to reset and let the agent re-pick.
 */
async function resetStuckJobs(maxAgeMinutes = 15): Promise<number> {
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

// ===== HTML page rendering =====

const SHARED_STYLES = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@500&family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&display=swap');

:root {
  --bg: #0a0a0a;
  --surface: #141414;
  --surface2: #1e1e1e;
  --border: #2a2a2a;
  --text: #f0f0f0;
  --text2: #888;
  --accent: #f97316;
  --green: #22c55e;
  --red: #ef4444;
  --amber: #f59e0b;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'DM Sans', sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
}

header {
  display: flex;
  align-items: center;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
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

.nav-tabs { display: flex; gap: 2px; flex: 1; margin-left: 24px; }
.nav-tab {
  padding: 8px 14px;
  color: var(--text2);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  border-radius: 6px;
  transition: all 0.15s;
}
.nav-tab:hover { color: var(--text); background: var(--bg); }
.nav-tab.active { color: var(--accent); background: var(--bg); }

main { padding: 24px; max-width: 1400px; margin: 0 auto; }

.page-header { margin-bottom: 20px; }
.page-title { font-size: 22px; font-weight: 600; }
.page-sub { color: var(--text2); font-size: 13px; margin-top: 4px; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
  margin-bottom: 16px;
}

.btn {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: black; }
.btn-primary:hover { opacity: 0.9; color: black; }
.btn-danger { background: var(--red); border-color: var(--red); color: white; }

.loading { color: var(--text2); padding: 24px; text-align: center; }

.muted { color: var(--text2); font-size: 13px; }
.mono { font-family: 'DM Mono', monospace; }
.hamburger {
  display: none;
  background: none;
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 11px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 20px;
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
  z-index: 999;
  padding: 8px 0;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.mobile-nav.open { display: block; }
.mobile-nav a {
  display: block;
  padding: 14px 20px;
  color: var(--text2);
  text-decoration: none;
  font-size: 15px;
  font-weight: 500;
  border-bottom: 1px solid var(--border);
}
.mobile-nav a:last-child { border-bottom: none; }
.mobile-nav a.active, .mobile-nav a:hover {
  background: var(--surface2);
  color: var(--accent);
}
@media (max-width: 768px) {
  .nav-tabs { display: none !important; }
  .hamburger { display: block; }
  header { padding: 10px 14px; }
  main { padding: 12px; }
}
`;

function pageHtml(
  active: 'orders' | 'metrics' | 'printers' | 'jobs',
  title: string,
  body: string,
  role: AdminRole = 'full',
): string {
  const isOperator = role === 'operator';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — FusionPrints Admin</title>
  <style>${SHARED_STYLES}</style>
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
      <a href="/admin/jobs" class="nav-tab ${active === 'jobs' ? 'active' : ''}">Order Management</a>
      <a href="/admin" class="nav-tab ${active === 'orders' ? 'active' : ''}">Dashboard</a>
      <a href="/admin/printers" class="nav-tab ${active === 'printers' ? 'active' : ''}">Printers</a>
      ${isOperator ? '' : `<a href="/admin/metrics" class="nav-tab ${active === 'metrics' ? 'active' : ''}">Key Metrics</a>`}
      ${isOperator ? '' : `<a href="/admin/promos" class="nav-tab">Promos</a>`}
      ${isOperator ? '' : `<a href="/admin/pricing" class="nav-tab">Pricing</a>`}
      ${isOperator ? '' : `<a href="/admin/qbo" class="nav-tab">QuickBooks</a>`}
    </nav>
  <button class="hamburger" id="hamburger-btn" onclick="toggleMobileNav()">&#9776;</button>
  </header>
  <div class="mobile-nav" id="mobile-nav">
    <a href="/admin/jobs" class="${active === 'jobs' ? 'active' : ''}">Order Management</a>
    <a href="/admin" class="${active === 'orders' ? 'active' : ''}">Dashboard</a>
    <a href="/admin/printers" class="${active === 'printers' ? 'active' : ''}">Printers</a>
    ${isOperator ? '' : `<a href="/admin/metrics" class="${active === 'metrics' ? 'active' : ''}">Key Metrics</a>`}
    ${isOperator ? '' : '<a href="/admin/qbo">QuickBooks</a>'}
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
  <main>${body}</main>
</body>
</html>`;
}

// Metrics page
function metricsPageHtml(): string {
  const body = `
  <div class="page-header">
    <div class="page-title">📊 Key Metrics</div>
    <div class="page-sub">Business performance over the last <select id="days-select" onchange="loadMetrics()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-family:inherit;">
      <option value="7">7 days</option>
      <option value="30" selected>30 days</option>
      <option value="90">90 days</option>
      <option value="365">12 months</option>
    </select></div>
  </div>

  <div id="content"><div class="loading">Loading metrics...</div></div>

  <script>
    async function loadMetrics() {
      const days = document.getElementById('days-select').value;
      const r = await fetch('/admin/api/ops/metrics?days=' + days);
      const data = await r.json();
      render(data);
    }

    function fmtMoney(v) { return '$' + v.toFixed(2); }
    function fmtInt(v) { return v.toLocaleString(); }

    function render(d) {
      const html = \`
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px;">
          <div class="card">
            <div class="muted">Revenue</div>
            <div style="font-size:26px;font-weight:600;margin-top:4px;">\${fmtMoney(d.revenue.totalUsd)}</div>
            <div class="muted">\${d.revenue.orderCount} orders</div>
          </div>
          <div class="card">
            <div class="muted">Avg order</div>
            <div style="font-size:26px;font-weight:600;margin-top:4px;">\${fmtMoney(d.revenue.avgOrderValue)}</div>
            <div class="muted">across all orders</div>
          </div>
          <div class="card">
            <div class="muted">New customers</div>
            <div style="font-size:26px;font-weight:600;margin-top:4px;">\${fmtInt(d.customers.newInPeriod)}</div>
            <div class="muted">\${fmtInt(d.customers.repeatInPeriod)} repeat customers</div>
          </div>
          <div class="card \${d.operational.failedJobs > 0 ? 'alert' : ''}" style="\${d.operational.failedJobs > 0 ? 'border-color:var(--red);' : ''}">
            <div class="muted">Failed print jobs</div>
            <div style="font-size:26px;font-weight:600;margin-top:4px;color:\${d.operational.failedJobs > 0 ? 'var(--red)' : 'var(--text)'}">\${fmtInt(d.operational.failedJobs)}</div>
            <div class="muted">requires attention</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          <div class="card">
            <div style="font-weight:600;margin-bottom:14px;">Daily revenue (14 days)</div>
            \${renderDailyChart(d.dailyRevenue)}
          </div>

          <div class="card">
            <div style="font-weight:600;margin-bottom:14px;">By print size</div>
            \${renderSizeBreakdown(d.sizeBreakdown)}
          </div>
        </div>

        <div class="card">
          <div style="font-weight:600;margin-bottom:14px;">Order status breakdown</div>
          \${renderStatusBreakdown(d.statusBreakdown)}
        </div>

        <div class="card" style="margin-top:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
            <div style="font-weight:600;">Landing page traffic</div>
            <div style="display:flex;gap:16px;">
              <div style="text-align:right;"><div class="muted" style="font-size:11px;">Today</div><div style="font-family:'DM Mono',monospace;font-weight:600;" id="visits-today">—</div></div>
              <div style="text-align:right;"><div class="muted" style="font-size:11px;">Total</div><div style="font-family:'DM Mono',monospace;font-weight:600;" id="visits-total">—</div></div>
              <div style="text-align:right;"><div class="muted" style="font-size:11px;">Waitlist</div><div style="font-family:'DM Mono',monospace;font-weight:600;" id="waitlist-count">—</div></div>
            </div>
          </div>
          <div id="traffic-chart"><div class="muted">Loading...</div></div>
          <div id="waitlist-table" style="margin-top:20px;"></div>
        </div>
      \`;
      document.getElementById('content').innerHTML = html;
      loadTraffic();
    }

    async function loadTraffic() {
      const days = document.getElementById('days-select').value;
      const r = await fetch('/admin/api/ops/traffic?days=' + days);
      const data = await r.json();

      document.getElementById('visits-today').textContent = fmtInt(data.totals.today);
      document.getElementById('visits-total').textContent = fmtInt(data.totals.total);
      document.getElementById('waitlist-count').textContent = fmtInt(data.signups.length);

      // Traffic bar chart
      const chart = document.getElementById('traffic-chart');
      if (!data.daily.length) {
        chart.innerHTML = '<div class="muted">No visits yet.</div>';
      } else {
        const max = Math.max(...data.daily.map(d => d.visits), 1);
        const CHART_HEIGHT = 100;
        chart.innerHTML = '<div style="display:flex;align-items:flex-end;gap:3px;height:' + (CHART_HEIGHT + 20) + 'px;overflow-x:auto;">' +
          data.daily.map(d => \`
            <div style="min-width:28px;flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
              <div style="font-size:10px;color:var(--text2);font-family:'DM Mono',monospace;">\${d.visits}</div>
              <div title="\${d.day}: \${d.visits} visits" style="width:100%;background:#3b82f6;height:\${Math.max((d.visits/max)*CHART_HEIGHT, 3)}px;border-radius:3px 3px 0 0;"></div>
              <div style="font-size:10px;color:var(--text2);font-family:'DM Mono',monospace;white-space:nowrap;">\${d.day.slice(5)}</div>
            </div>
          \`).join('') + '</div>';
      }

      // Waitlist table
      const table = document.getElementById('waitlist-table');
      if (!data.signups.length) {
        table.innerHTML = '<div class="muted" style="font-size:13px;">No waitlist signups yet.</div>';
      } else {
        table.innerHTML = '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text2);margin-bottom:8px;">Waitlist (' + data.signups.length + ')</div>' +
          data.signups.map(s => \`
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
              <div style="font-weight:500;">\${s.name}</div>
              <div style="font-family:'DM Mono',monospace;color:var(--text2);">\${s.whatsapp}</div>
              <div style="color:var(--text2);font-size:11px;">\${new Date(s.createdAt).toLocaleDateString()}</div>
            </div>
          \`).join('');
      }
    }

    function renderDailyChart(data) {
      if (!data.length) return '<div class="muted">No revenue yet.</div>';
      const max = Math.max(...data.map(d => d.revenue), 1);
      return '<div style="display:flex;align-items:flex-end;gap:4px;height:160px;">' +
        data.map(d => \`
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
            <div title="\${d.day}: \${fmtMoney(d.revenue)}" style="width:100%;background:var(--accent);height:\${(d.revenue / max) * 130}px;min-height:2px;border-radius:3px 3px 0 0;"></div>
            <div style="font-size:10px;color:var(--text2);font-family:'DM Mono',monospace">\${d.day.slice(5)}</div>
          </div>
        \`).join('') +
        '</div>';
    }

    function renderSizeBreakdown(data) {
      if (!data.length) return '<div class="muted">No prints yet.</div>';
      const total = data.reduce((s, d) => s + d.totalPrints, 0);
      return data.sort((a,b) => b.totalPrints - a.totalPrints).map(d => \`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <div style="width:60px;font-family:'DM Mono',monospace;font-size:13px;">\${d.sizeCode}</div>
          <div style="flex:1;background:var(--surface2);border-radius:4px;height:18px;overflow:hidden;">
            <div style="background:var(--accent);height:100%;width:\${(d.totalPrints/total)*100}%;"></div>
          </div>
          <div style="font-size:13px;width:80px;text-align:right;font-family:'DM Mono',monospace;">\${d.totalPrints}</div>
          <div style="font-size:13px;width:80px;text-align:right;color:var(--text2);">\${fmtMoney(d.revenue)}</div>
        </div>
      \`).join('');
    }

    function renderStatusBreakdown(data) {
      if (!data.length) return '<div class="muted">No orders yet.</div>';
      return '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
        data.sort((a,b) => b.count - a.count).map(d => \`
          <div style="background:var(--surface2);padding:8px 14px;border-radius:6px;">
            <div class="muted" style="font-size:11px;">\${d.status.replace(/_/g, ' ')}</div>
            <div style="font-weight:600;font-family:'DM Mono',monospace;">\${d.count}</div>
          </div>
        \`).join('') + '</div>';
    }

    loadMetrics();
  </script>`;
  return pageHtml('metrics', 'Key Metrics', body);
}

// Printers page
function printersPageHtml(role: AdminRole = 'full'): string {
  const body = `
  <div class="page-header">
    <div class="page-title">🖨️ Printer Status</div>
    <div class="page-sub">Live status from print agents. Heartbeats arrive every 30 seconds.</div>
  </div>

  <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn" onclick="loadPrinters()">↻ Refresh</button>
    ${role === 'operator' ? '' : '<button class="btn" onclick="resetStuck()">🔧 Reset stuck jobs</button>'}
  </div>

  <div id="content"><div class="loading">Loading printers...</div></div>

  <script>
    async function loadPrinters() {
      const r = await fetch('/admin/api/ops/printers');
      const data = await r.json();
      render(data.printers);
    }

    function statusColor(s) {
      return s === 'online' ? 'var(--green)' : s === 'stale' ? 'var(--amber)' : 'var(--red)';
    }

    function fmtTime(t) {
      if (!t) return 'never';
      const d = new Date(t);
      const ago = (Date.now() - d.getTime()) / 1000;
      if (ago < 60) return Math.floor(ago) + 's ago';
      if (ago < 3600) return Math.floor(ago / 60) + 'm ago';
      if (ago < 86400) return Math.floor(ago / 3600) + 'h ago';
      return Math.floor(ago / 86400) + 'd ago';
    }

    function render(printers) {
      if (!printers.length) {
        document.getElementById('content').innerHTML = '<div class="card"><div class="muted">No printers registered yet. The print agent will register them when it first connects.</div></div>';
        return;
      }
      const html = printers.map(p => \`
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:18px;font-weight:600;">\${p.name}</div>
              <div class="muted" style="margin-top:4px;">Type: \${p.type.replace('_', ' ')}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <div style="width:10px;height:10px;border-radius:50%;background:\${statusColor(p.staleness)};animation:\${p.staleness === 'online' ? 'pulse 2s infinite' : 'none'};"></div>
              <div style="font-weight:500;color:\${statusColor(p.staleness)};">\${p.staleness}</div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:16px;">
            <div>
              <div class="muted" style="font-size:11px;">Status</div>
              <div style="font-family:'DM Mono',monospace;margin-top:2px;">\${p.status}</div>
            </div>
            <div>
              <div class="muted" style="font-size:11px;">Last heartbeat</div>
              <div style="font-family:'DM Mono',monospace;margin-top:2px;">\${fmtTime(p.lastHeartbeat)}</div>
            </div>
            <div>
              <div class="muted" style="font-size:11px;">Printer ID</div>
              <div style="font-family:'DM Mono',monospace;margin-top:2px;font-size:11px;color:var(--text2);">\${p.id.slice(0, 8)}</div>
            </div>
          </div>

          \${p.errorMessage ? \`<div style="margin-top:14px;padding:10px;background:rgba(239,68,68,0.1);border:1px solid var(--red);border-radius:6px;color:var(--red);font-size:13px;">⚠️ \${p.errorMessage}</div>\` : ''}
        </div>
      \`).join('');
      document.getElementById('content').innerHTML = html;
    }

    async function resetStuck() {
      if (!confirm('Reset all jobs that have been printing for more than 15 minutes back to queued?')) return;
      const r = await fetch('/admin/api/ops/reset-stuck-jobs', { method: 'POST' });
      const data = await r.json();
      alert('Reset ' + data.count + ' stuck job(s).');
    }

    loadPrinters();
    // Auto-refresh every 15 seconds
    setInterval(loadPrinters, 15000);
  </script>

  <style>
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  </style>`;
  return pageHtml('printers', 'Printers', body, role);
}


/**
 * Reprint a batch of jobs by ID.
 */
async function reprintJobBatch(jobIds: string[]): Promise<number> {
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

interface Tally {
  done: number;
  total: number;
}
const emptyTally = (): Tally => ({ done: 0, total: 0 });

interface ActiveOrderRow {
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

async function getActiveOrders(): Promise<ActiveOrderRow[]> {
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

async function getCompletedOrdersList() {
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

function omCell(t: Tally): string {
  if (t.total === 0) return '<span style="color:var(--text-mute,#8a7b66)">—</span>';
  const done = t.done === t.total;
  return `<span style="${done ? 'color:#05D668;font-weight:600' : ''}">${t.done} / ${t.total}</span>`;
}

function omDate(d: Date): string {
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function orderManagementPageHtml(tab: 'active' | 'completed', role: AdminRole): Promise<string> {
  const tabBar = `
    <div class="om-tabs">
      <a href="/admin/jobs?tab=active" class="om-tab ${tab === 'active' ? 'active' : ''}">Active</a>
      <a href="/admin/jobs?tab=completed" class="om-tab ${tab === 'completed' ? 'active' : ''}">Completed</a>
    </div>`;

  let table: string;
  if (tab === 'completed') {
    const rows = await getCompletedOrdersList();
    table = `<table class="om">
      <thead><tr><th>Date</th><th>Order #</th><th>Name</th><th>Status</th><th>Total</th><th>Fulfilment</th><th></th></tr></thead>
      <tbody>${
        rows.length === 0
          ? '<tr><td colspan="7" class="om-empty">No completed orders.</td></tr>'
          : rows
              .map(
                (o) => `<tr>
        <td>${omDate(o.createdAt)}</td>
        <td class="om-mono">${o.orderNumber}</td>
        <td>${o.name ?? '<span style="color:#8a7b66">—</span>'}</td>
        <td><span class="om-badge">${o.status.replace(/_/g, ' ')}</span></td>
        <td class="om-mono">$${parseFloat(o.totalUsd).toFixed(2)}</td>
        <td>${o.fulfillmentMethod === 'delivery' ? '🚚 Delivery' : '🏪 Collection'}</td>
        <td><a class="om-link" href="/admin?order=${o.id}">View</a></td>
      </tr>`,
              )
              .join('')
      }</tbody>
    </table>`;
  } else {
    const rows = await getActiveOrders();
    table = `<table class="om">
      <thead><tr><th>Date</th><th>Order #</th><th>Name</th><th>Small Print</th><th>5″ Prints</th><th>Large Prints</th><th>Poster</th><th>Slips</th><th></th></tr></thead>
      <tbody>${
        rows.length === 0
          ? '<tr><td colspan="9" class="om-empty">No active orders. Paid orders appear here while they print.</td></tr>'
          : rows
              .map(
                (o) => `<tr>
        <td>${omDate(o.createdAt)}</td>
        <td class="om-mono">${o.orderNumber}</td>
        <td>${o.name ?? '<span style="color:#8a7b66">—</span>'}</td>
        <td>${omCell(o.small)}</td>
        <td>${omCell(o.fiveinch)}</td>
        <td>${omCell(o.large)}</td>
        <td>${omCell(o.poster)}</td>
        <td>${omCell(o.slips)}</td>
        <td>${
          o.failed > 0
            ? `<button class="om-btn" onclick="reprintOrder('${o.id}')">↻ ${o.failed} failed</button>`
            : `<a class="om-link" href="/admin?order=${o.id}">View</a>`
        }</td>
      </tr>`,
              )
              .join('')
      }</tbody>
    </table>`;
  }

  const refresh = tab === 'active' ? '<script>setTimeout(function(){location.reload();}, 5000);</script>' : '';
  const body = `
    <style>
      .om-tabs { display:flex; gap:4px; margin-bottom:16px; }
      .om-tab { padding:8px 18px; border-radius:8px 8px 0 0; font-weight:600; font-size:14px; color:var(--mute,#8a7b66); text-decoration:none; border-bottom:2px solid transparent; }
      .om-tab.active { color:var(--text,#1f1b16); border-bottom-color:#05D668; }
      table.om { width:100%; border-collapse:collapse; background:var(--surface,#fff); border-radius:10px; overflow:hidden; font-size:13px; }
      table.om th, table.om td { text-align:left; padding:10px 12px; border-bottom:1px solid #00000010; }
      table.om th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--mute,#8a7b66); }
      .om-mono { font-family:ui-monospace,monospace; }
      .om-badge { font-size:11px; text-transform:capitalize; background:#00000008; padding:2px 8px; border-radius:999px; }
      .om-link { color:#04A551; font-weight:600; text-decoration:none; }
      .om-btn { cursor:pointer; border:1px solid #ff7a5955; color:#ff7a59; background:transparent; border-radius:8px; padding:5px 10px; font-size:12px; font-weight:600; }
      .om-empty { text-align:center; color:var(--mute,#8a7b66); padding:28px; }
    </style>
    ${tabBar}
    ${table}
    <script>
      async function reprintOrder(id) {
        if (!confirm('Reprint failed jobs for this order?')) return;
        await fetch('/admin/api/ops/orders/' + id + '/reprint', { method: 'POST' });
        location.reload();
      }
    </script>
    ${refresh}`;
  return pageHtml('jobs', 'Order Management', body, role);
}

// ===== Route registration =====

export async function registerAdminOps(app: FastifyInstance): Promise<void> {

  // ===== Pages =====

  // Metrics page — full admin only. Operator gets redirected to /admin
  // (their home page) with a soft "admin access required" notice.
  app.get('/admin/metrics', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    reply.type('text/html').send(metricsPageHtml());
  });

  // Printers page — both roles. Operator gets read-only mode (action
  // buttons hidden) via the role param passed into the HTML renderer.
  app.get('/admin/printers', async (request, reply) => {
    const role = authenticatePage(request, reply);
    if (role === null) return;
    reply.type('text/html').send(printersPageHtml(role));
  });

  // Print Queue page — both roles. Operator has full access (their job
  // is to ensure jobs print successfully).
  // Order Management — Active (in-pipeline, bucketed printed/total) + Completed tabs.
  app.get('/admin/jobs', async (request, reply) => {
    const role = authenticatePage(request, reply);
    if (role === null) return;
    const tab = (request.query as { tab?: string }).tab === 'completed' ? 'completed' : 'active';
    reply.type('text/html').send(await orderManagementPageHtml(tab, role));
  });

  // ===== API =====

  // Mark order as shipped
  app.post('/admin/api/ops/orders/:id/shipped', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await markShipped(id);
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to mark order shipped');
      reply.status(500).send({ error: 'Failed to update' });
    }
  });

  // Reprint a single job
  app.post('/admin/api/ops/jobs/:id/reprint', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await reprintJob(id);
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to reprint job');
      reply.status(500).send({ error: 'Failed to reprint' });
    }
  });

  // Reprint all failed jobs in an order
  app.post('/admin/api/ops/orders/:id/reprint', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const count = await reprintOrder(id);
      return { ok: true, count };
    } catch (err) {
      logger.error({ err }, 'Failed to reprint order');
      reply.status(500).send({ error: 'Failed to reprint' });
    }
  });

  // Send receipt via WhatsApp — full admin only (financial document)
  app.post('/admin/api/ops/orders/:id/send-receipt', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const ok = await sendReceiptViaWhatsApp(id);
      return { ok };
    } catch (err) {
      logger.error({ err }, 'Failed to send receipt');
      reply.status(500).send({ error: 'Failed to send receipt' });
    }
  });

  // Preview receipt text — full admin only (shows pricing)
  app.get('/admin/api/ops/orders/:id/receipt-preview', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const text = await generateReceiptText(id);
      if (!text) {
        reply.status(404).send({ error: 'Order not found' });
        return;
      }
      return { text };
    } catch (err) {
      logger.error({ err }, 'Failed to preview receipt');
      reply.status(500).send({ error: 'Failed to preview' });
    }
  });

  // Get printer status (with computed staleness)
  app.get('/admin/api/ops/printers', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      return { printers: await getPrinterStatus() };
    } catch (err) {
      logger.error({ err }, 'Failed to get printer status');
      reply.status(500).send({ error: 'Failed to load printers' });
    }
  });

  // Metrics dashboard data — full admin only (revenue, business KPIs)
  app.get('/admin/api/ops/metrics', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { days } = request.query as { days?: string };
      const daysBack = days ? Math.max(1, Math.min(365, parseInt(days, 10))) : 30;
      return await getDashboardMetrics(daysBack);
    } catch (err) {
      logger.error({ err }, 'Failed to get metrics');
      reply.status(500).send({ error: 'Failed to load metrics' });
    }
  });


  // Reprint a batch of jobs — full admin only (potential cost impact)
  app.post('/admin/api/ops/jobs/reprint-batch', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { jobIds } = request.body as { jobIds: string[] };
      if (!Array.isArray(jobIds) || jobIds.length === 0) {
        reply.status(400).send({ error: 'jobIds required' });
        return;
      }
      const count = await reprintJobBatch(jobIds);
      return { ok: true, count };
    } catch (err) {
      logger.error({ err }, 'Failed to batch reprint');
      reply.status(500).send({ error: 'Failed to reprint' });
    }
  });

  // Landing page traffic + waitlist — full admin only
  app.get('/admin/api/ops/traffic', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { days } = request.query as { days?: string };
      const daysBack = days ? Math.max(1, Math.min(365, parseInt(days, 10))) : 30;
      const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

      const daily = await db
        .select({
          day:   sql<string>`DATE(${siteVisits.visitedAt})::text`,
          visits: sql<string>`COUNT(*)::text`,
        })
        .from(siteVisits)
        .where(gte(siteVisits.visitedAt, cutoff))
        .groupBy(sql`DATE(${siteVisits.visitedAt})`)
        .orderBy(sql`DATE(${siteVisits.visitedAt})`);

      const [totals] = await db
        .select({
          total:     sql<string>`COUNT(*)::text`,
          today:     sql<string>`COUNT(*) FILTER (WHERE DATE(${siteVisits.visitedAt}) = CURRENT_DATE)::text`,
        })
        .from(siteVisits);

      const signups = await db
        .select({
          id:        waitlist.id,
          name:      waitlist.name,
          whatsapp:  waitlist.whatsapp,
          createdAt: waitlist.createdAt,
          notifiedAt: waitlist.notifiedAt,
        })
        .from(waitlist)
        .orderBy(sql`${waitlist.createdAt} DESC`);

      return {
        daily: daily.map(r => ({ day: r.day, visits: parseInt(r.visits, 10) })),
        totals: {
          total: parseInt(totals?.total ?? '0', 10),
          today: parseInt(totals?.today ?? '0', 10),
        },
        signups,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get traffic data');
      reply.status(500).send({ error: 'Failed to load traffic' });
    }
  });

  // Reset stuck print jobs — full admin only (system maintenance)
  app.post('/admin/api/ops/reset-stuck-jobs', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const count = await resetStuckJobs();
      return { ok: true, count };
    } catch (err) {
      logger.error({ err }, 'Failed to reset stuck jobs');
      reply.status(500).send({ error: 'Failed to reset jobs' });
    }
  });
}
