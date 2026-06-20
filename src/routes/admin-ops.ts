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
import { gte, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { siteVisits, waitlist } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { ADMIN_FONT_CSS } from '@/routes/admin-fonts.js';
import { authenticate, authenticatePage, requireFullAdmin, requireFullAdminPage, type AdminRole } from '@/utils/auth.js';
import {
  markShipped,
  reprintJob,
  reprintOrder,
  reprintJobBatch,
  resetStuckJobs,
  getPrinterStatus,
  getDashboardMetrics,
  generateReceiptText,
  sendReceiptViaWhatsApp,
  getActiveOrders,
  getCompletedOrdersList,
  type Tally,
} from '@/services/admin-ops.js';

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

// ===== HTML page rendering =====

const SHARED_STYLES = `
${ADMIN_FONT_CSS}

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
      <a href="/admin/printers" class="nav-tab ${active === 'printers' ? 'active' : ''}">Printers and Configuration</a>
      ${isOperator ? '' : `<a href="/admin/metrics" class="nav-tab ${active === 'metrics' ? 'active' : ''}">Key Metrics</a>`}
      ${isOperator ? '' : `<a href="/admin/promos" class="nav-tab">Promos</a>`}
      ${isOperator ? '' : `<a href="/admin/pricing" class="nav-tab">Pricing</a>`}
      ${isOperator ? '' : `<a href="/admin/qbo" class="nav-tab">QuickBooks</a>`}
    </nav>
  <button class="hamburger" id="hamburger-btn" onclick="toggleMobileNav()">&#9776;</button>
  </header>
  <div class="mobile-nav" id="mobile-nav">
    <a href="/admin/jobs" class="${active === 'jobs' ? 'active' : ''}">Order Management</a>
    <a href="/admin/printers" class="${active === 'printers' ? 'active' : ''}">Printers and Configuration</a>
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

  <style>
    .ops-snapshot { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin-bottom:24px; }
    .ops-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px; }
    .ops-card .l { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--text2); margin-bottom:6px; }
    .ops-card .v { font-size:26px; font-weight:600; }
    .ops-card .v.red { color:var(--red); } .ops-card .v.green { color:var(--green); }
    .ops-card .v.blue { color:#60a5fa; } .ops-card .v.yellow { color:var(--amber); } .ops-card .v.orange { color:var(--accent); }
    @media (max-width:768px) { .ops-snapshot { grid-template-columns:repeat(2,1fr); } }
  </style>
  <div class="page-sub" style="margin:-8px 0 8px;">Live operations snapshot</div>
  <div id="ops-snapshot" class="ops-snapshot"><div class="loading">Loading…</div></div>

  <div id="content"><div class="loading">Loading metrics...</div></div>

  <script>
    async function loadSnapshot() {
      try {
        const r = await fetch('/admin/api/stats');
        if (!r.ok) return;
        const s = await r.json();
        document.getElementById('ops-snapshot').innerHTML =
          '<div class="ops-card"><div class="l">Today\\'s orders</div><div class="v orange">' + (s.todayOrders ?? 0) + '</div></div>'
        + '<div class="ops-card"><div class="l">Today\\'s revenue</div><div class="v green">$' + (s.todayRevenue ?? 0) + '</div></div>'
        + '<div class="ops-card"><div class="l">Needs approval</div><div class="v ' + (s.pendingApproval > 0 ? 'red' : '') + '">' + (s.pendingApproval ?? 0) + '</div></div>'
        + '<div class="ops-card"><div class="l">Ready to collect</div><div class="v blue">' + (s.readyForCollection ?? 0) + '</div></div>'
        + '<div class="ops-card"><div class="l">In print queue</div><div class="v yellow">' + (s.queuedForPrint ?? 0) + '</div></div>'
        + '<div class="ops-card"><div class="l">Pending payment</div><div class="v">' + (s.pendingPayment ?? 0) + '</div></div>';
      } catch (e) { /* leave placeholder */ }
    }

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
    loadSnapshot();
  </script>`;
  return pageHtml('metrics', 'Key Metrics', body);
}

// Printers page
function printersPageHtml(role: AdminRole = 'full'): string {
  const body = `
  <div class="page-header">
    <div class="page-title">🖨️ Printers and Configuration</div>
    <div class="page-sub">Printer status (heartbeats every 30s) and the DNP media-mode control.</div>
  </div>

  <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn" onclick="loadPrinters()">↻ Refresh</button>
    ${role === 'operator' ? '' : '<button class="btn" onclick="resetStuck()">🔧 Reset stuck jobs</button>'}
  </div>

  <div id="dnp-media-bar" style="margin:0 0 16px;"></div>

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

    // DNP media-mode control. The single DNP prints one media family at a time;
    // 5×7 jobs are held until the operator loads 5×7 media and switches mode here.
    // An operational control — visible to both operators and admins.
    async function loadMediaBar() {
      try {
        const r = await fetch('/admin/api/stats');
        if (!r.ok) return;
        const s = await r.json();
        renderDnpMediaBar(s.dnpMediaMode || '6x8', s.pending5x7 ?? 0);
      } catch (e) { /* leave placeholder */ }
    }

    function renderDnpMediaBar(mode, pending) {
      const bar = document.getElementById('dnp-media-bar');
      if (!bar) return;
      if (mode === '5x7') {
        bar.innerHTML =
          '<div style="background:#7c2d12;border:1px solid var(--accent);border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">'
          + '<div><strong>⚠️ DNP is in 5×7 mode</strong> — regular 4×6/6×8 prints are PAUSED. Print the 5×7 batch, then switch back.</div>'
          + '<button class="action-btn" style="background:#16a34a;color:#fff;" onclick="setDnpMode(\\'6x8\\')">↩ Switch back to 6×8</button>'
          + '</div>';
      } else {
        const hot = pending > 0;
        bar.innerHTML =
          '<div style="background:#111827;border:1px solid ' + (hot ? 'var(--accent)' : '#374151') + ';border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">'
          + '<div>DNP media: <strong>6×8</strong> · ' + (hot ? '<span style="color:var(--accent);font-weight:600;">' + pending + ' held 5×7 print(s) waiting</span>' : 'no 5×7 waiting') + '</div>'
          + (hot ? '<button class="action-btn" style="background:var(--accent);color:#fff;" onclick="setDnpMode(\\'5x7\\')">🔁 Switch to 5×7 &amp; print held batch</button>' : '')
          + '</div>';
      }
    }

    async function setDnpMode(mode) {
      const msg = mode === '5x7'
        ? 'Switch DNP to 5×7 mode?\\n\\nLoad 5×7 media on the printer FIRST. This releases the held 5×7 jobs and PAUSES regular 4×6/6×8 prints until you switch back.'
        : 'Switch DNP back to 6×8 mode?\\n\\nReload 6×8 media. Regular prints resume; any remaining 5×7 jobs are held again.';
      if (!confirm(msg)) return;
      const r = await fetch('/admin/api/dnp-media-mode', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mode: mode }) });
      if (!r.ok) {
        const d = await r.json().catch(function(){ return {}; });
        alert(d.error || 'Failed to change DNP media mode');
        return;
      }
      loadMediaBar();
    }

    loadPrinters();
    loadMediaBar();
    // Auto-refresh every 15 seconds
    setInterval(loadPrinters, 15000);
    setInterval(loadMediaBar, 15000);
  </script>

  <style>
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  </style>`;
  return pageHtml('printers', 'Printers and Configuration', body, role);
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
      ${tab === 'active' ? '<span class="om-live"><span class="dot"></span>Live</span>' : ''}
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
        <td><a class="om-link" href="#" onclick="showOrder('${o.id}');return false;">View</a></td>
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
            : `<a class="om-link" href="#" onclick="showOrder('${o.id}');return false;">View</a>`
        }</td>
      </tr>`,
              )
              .join('')
      }</tbody>
    </table>`;
  }

  const autoRefresh = tab === 'active';
  const body = `
    <style>
      :root { --blue:#3b82f6; --radius:8px; }
      .om-tabs { display:flex; gap:4px; margin-bottom:16px; align-items:center; }
      .om-tab { padding:8px 18px; border-radius:8px 8px 0 0; font-weight:600; font-size:14px; color:var(--mute,#8a7b66); text-decoration:none; border-bottom:2px solid transparent; }
      .om-tab.active { color:var(--text,#1f1b16); border-bottom-color:#05D668; }
      .om-live { margin-left:auto; display:flex; align-items:center; gap:6px; font-size:12px; color:var(--mute,#8a7b66); }
      .om-live .dot { width:7px; height:7px; border-radius:50%; background:#05D668; animation:ompulse 2s infinite; }
      @keyframes ompulse { 0%,100%{opacity:1;} 50%{opacity:.3;} }
      table.om { width:100%; border-collapse:collapse; background:var(--surface,#fff); border-radius:10px; overflow:hidden; font-size:13px; }
      table.om th, table.om td { text-align:left; padding:10px 12px; border-bottom:1px solid #00000010; }
      table.om th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--mute,#8a7b66); }
      .om-mono { font-family:ui-monospace,monospace; }
      .om-badge { font-size:11px; text-transform:capitalize; background:#00000008; padding:2px 8px; border-radius:999px; }
      .om-link { color:#04A551; font-weight:600; text-decoration:none; cursor:pointer; }
      .om-btn { cursor:pointer; border:1px solid #ff7a5955; color:#ff7a59; background:transparent; border-radius:8px; padding:5px 10px; font-size:12px; font-weight:600; }
      .om-empty { text-align:center; color:var(--mute,#8a7b66); padding:28px; }

      /* Order detail modal (shared theme with the rest of admin) */
      .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:200; align-items:center; justify-content:center; padding:24px; }
      .modal-overlay.open { display:flex; }
      .modal { background:var(--surface); border:1px solid var(--border); border-radius:12px; width:100%; max-width:560px; max-height:80vh; overflow-y:auto; }
      .modal-header { padding:16px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
      .modal-title { font-weight:600; font-family:'DM Mono',monospace; color:var(--accent); }
      .modal-close { background:none; border:none; color:var(--text2); cursor:pointer; font-size:20px; padding:0 4px; }
      .modal-body { padding:20px; }
      .detail-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border); font-size:13px; }
      .detail-row:last-child { border-bottom:none; }
      .detail-label { color:var(--text2); }
      .detail-value { font-weight:500; text-align:right; }
      .items-list { margin-top:16px; }
      .items-title { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text2); margin-bottom:8px; }
      .item-row { background:var(--surface2); border-radius:6px; padding:10px 12px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; font-size:13px; }
      .loading, .empty { text-align:center; padding:40px; color:var(--text2); font-size:13px; }
      .badge { display:inline-flex; align-items:center; gap:4px; padding:3px 8px; border-radius:4px; font-size:11px; font-weight:500; white-space:nowrap; }
      .badge-pending_payment { background:#1c1917; color:#a8a29e; border:1px solid #292524; }
      .badge-paid { background:#052e16; color:#86efac; border:1px solid #14532d; }
      .badge-awaiting_approval { background:#431407; color:#fdba74; border:1px solid #7c2d12; }
      .badge-queued_for_print { background:#1e3a5f; color:#93c5fd; border:1px solid #1d4ed8; }
      .badge-printing { background:#1e3a5f; color:#60a5fa; border:1px solid #2563eb; }
      .badge-printed { background:#422006; color:#fbbf24; border:1px solid #92400e; }
      .badge-ready_for_pickup, .badge-ready_for_collection { background:#052e16; color:#4ade80; border:1px solid #16a34a; }
      .badge-fulfilled, .badge-cancelled { background:#141414; color:#6b7280; border:1px solid #374151; }
      .badge-failed { background:#450a0a; color:#f87171; border:1px solid #991b1b; }
      .action-btn { padding:5px 10px; border-radius:5px; border:1px solid var(--border); background:transparent; color:var(--text); font-size:11px; cursor:pointer; margin-right:4px; }
      .action-btn:hover { background:var(--surface2); }
      .action-btn.approve { border-color:var(--green); color:var(--green); }
      .action-btn.ready { border-color:var(--blue); color:var(--blue); }
      .action-btn.fulfil { border-color:var(--text2); color:var(--text2); }
      .action-btn.cancel { border-color:var(--red); color:var(--red); }
      @media (max-width:768px) { .modal-overlay { padding:0; align-items:flex-end; } .modal { max-width:100%; max-height:92vh; border-radius:12px 12px 0 0; } }
    </style>
    ${tabBar}
    <div id="om-content">${table}</div>

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

      // Silently refresh just the table in the background (no visible page reload).
      let omRefreshing = false;
      async function omRefresh() {
        if (omRefreshing || document.hidden) return;
        omRefreshing = true;
        try {
          const res = await fetch(location.pathname + location.search, { cache: 'no-store' });
          if (res.ok) {
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            const fresh = doc.getElementById('om-content');
            const cur = document.getElementById('om-content');
            if (fresh && cur) cur.innerHTML = fresh.innerHTML;
          }
        } catch (e) { /* transient — try again next tick */ }
        omRefreshing = false;
      }

      function statusLabel(status) {
        const labels = { pending_payment:'Pending payment', paid:'Paid', awaiting_approval:'Needs approval', queued_for_print:'In queue', printing:'Printing', printed:'Printed (release?)', ready_for_pickup:'Ready for pickup', ready_for_collection:'Ready', fulfilled:'Fulfilled', cancelled:'Cancelled', failed:'Failed' };
        return labels[status] || status;
      }

      async function showOrder(orderId) {
        document.getElementById('modal-overlay').classList.add('open');
        document.getElementById('modal-body').innerHTML = '<div class="loading">Loading...</div>';
        const res = await fetch(\`/admin/api/orders/\${orderId}\`);
        const data = await res.json();
        if (!data) { document.getElementById('modal-body').innerHTML = '<div class="empty">Order not found.</div>'; return; }
        const { order, customer, items, jobs, slips } = data;
        document.getElementById('modal-title').textContent = order.orderNumber;
        const slipLabels = { end_separator:'Separator', order_info:'Order info', promo:'Promo card' };
        const slipsHtml = (slips || []).map(s => \`
          <div class="item-row">
            <span style="display:flex;align-items:center;gap:10px;">
              \${s.previewUrl ? \`<a href="\${s.previewUrl}" target="_blank" rel="noopener"><img src="\${s.previewUrl}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:4px;background:var(--surface);" /></a>\` : '<span style="width:44px;height:44px;border-radius:4px;background:var(--surface);display:inline-flex;align-items:center;justify-content:center;font-size:18px;opacity:0.4;">🪪</span>'}
              <span>\${slipLabels[s.slipType] || s.slipType}</span>
            </span>
            <span class="badge badge-\${s.status}">\${s.status}</span>
          </div>\`).join('');
        const itemsHtml = items.map(item => \`
          <div class="item-row">
            <span style="display:flex;align-items:center;gap:10px;">
              \${item.previewUrl ? \`<a href="\${item.previewUrl}" target="_blank" rel="noopener"><img src="\${item.previewUrl}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:4px;background:var(--surface);" /></a>\` : '<span style="width:44px;height:44px;border-radius:4px;background:var(--surface);display:inline-flex;align-items:center;justify-content:center;font-size:18px;opacity:0.4;">🖼</span>'}
              <span>\${item.quantity} × \${item.sizeCode} (\${item.productType.replace('_', ' ')})\${item.layoutPayload && item.layoutPayload.cells ? ' · <span style="color:var(--accent)">' + item.layoutPayload.cells.length + '-cell composite</span>' : ''}</span>
            </span>
            \${IS_OPERATOR ? '' : \`<span>$\${parseFloat(item.lineTotalUsd).toFixed(2)}</span>\`}
          </div>\`).join('');
        document.getElementById('modal-body').innerHTML = \`
          <div class="detail-row"><span class="detail-label">Customer</span><span class="detail-value">\${customer?.name || 'Unknown'}</span></div>
          <div class="detail-row"><span class="detail-label">Phone</span><span class="detail-value">\${customer?.phoneNumber || '—'}</span></div>
          <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value"><span class="badge badge-\${order.status}">\${statusLabel(order.status)}</span></span></div>
          \${IS_OPERATOR ? '' : \`<div class="detail-row"><span class="detail-label">Total</span><span class="detail-value">$\${parseFloat(order.totalUsd).toFixed(2)}</span></div>\`}
          <div class="detail-row"><span class="detail-label">Fulfillment</span><span class="detail-value">\${order.fulfillmentMethod === 'collection' ? '🏪 Collection' : '🚚 Delivery'}</span></div>
          \${order.deliveryAddress ? \`<div class="detail-row"><span class="detail-label">Address</span><span class="detail-value">\${order.deliveryAddress}</span></div>\` : ''}
          <div class="detail-row"><span class="detail-label">Ordered</span><span class="detail-value">\${new Date(order.createdAt).toLocaleString()}</span></div>
          \${order.paidAt ? \`<div class="detail-row"><span class="detail-label">Paid</span><span class="detail-value">\${new Date(order.paidAt).toLocaleString()}</span></div>\` : ''}
          <div class="items-list"><div class="items-title">Items (\${items.length})</div>\${itemsHtml}</div>
          \${jobs.length > 0 ? \`<div class="items-list" style="margin-top:16px"><div class="items-title">Print jobs</div>\${jobs.map(j => \`<div class="item-row"><span>\${j.printerName || 'Unassigned'}</span><span style="display:flex;gap:8px;align-items:center;"><span class="badge badge-\${j.status}">\${j.status}</span>\${j.status === 'failed' ? \`<button class="action-btn approve" style="padding:3px 8px;font-size:11px" onclick="reprintJob('\${j.id}')">↻ Reprint</button>\` : ''}</span></div>\`).join('')}</div>\` : ''}
          \${(slips && slips.length > 0) ? \`<div class="items-list" style="margin-top:16px"><div class="items-title">Slip cards (\${slips.length})</div>\${slipsHtml}</div>\` : ''}
          <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
            \${order.status === 'awaiting_approval' ? \`<button class="action-btn approve" onclick="doAction('\${order.id}', 'approve'); closeModal()">✓ Approve for printing</button>\` : ''}
            \${order.status === 'printed' && order.fulfillmentMethod !== 'delivery' ? \`<button class="action-btn approve" onclick="doAction('\${order.id}', 'release-for-pickup'); closeModal()">📦 Release for pickup</button>\` : ''}
            \${order.status === 'printed' && order.fulfillmentMethod === 'delivery' ? \`<button class="action-btn approve" onclick="doOpsAction('\${order.id}', 'shipped'); closeModal()">🚚 Mark out for delivery</button>\` : ''}
            \${order.status === 'ready_for_collection' && order.fulfillmentMethod === 'delivery' ? \`<button class="action-btn ready" onclick="doOpsAction('\${order.id}', 'shipped'); closeModal()">🚚 Mark out for delivery</button>\` : ''}
            \${(order.status === 'ready_for_collection' || order.status === 'ready_for_pickup' || order.status === 'shipped') ? \`<button class="action-btn fulfil" onclick="doAction('\${order.id}', 'fulfil'); closeModal()">✓ Mark fulfilled</button>\` : ''}
            \${jobs.some(j => j.status === 'failed') ? \`<button class="action-btn approve" onclick="reprintOrder('\${order.id}')">↻ Reprint failed jobs</button>\` : ''}
            <button class="action-btn ready" onclick="previewReceipt('\${order.id}')">📄 Receipt</button>
            \${(!IS_OPERATOR && !['fulfilled','cancelled','failed'].includes(order.status)) ? \`<button class="action-btn cancel" onclick="doAction('\${order.id}', 'cancel'); closeModal()">Cancel order</button>\` : ''}
          </div>\`;
      }

      async function doAction(orderId, action) {
        if (action === 'cancel' && !confirm('Cancel this order?')) return;
        await fetch(\`/admin/api/orders/\${orderId}/\${action}\`, { method: 'POST' });
        omRefresh();
      }
      async function doOpsAction(orderId, action) {
        try { const r = await fetch('/admin/api/ops/orders/' + orderId + '/' + action, { method: 'POST' }); if (!r.ok) throw new Error(); omRefresh(); } catch (e) { alert('Action failed'); }
      }
      async function reprintJob(jobId) {
        if (!confirm('Requeue this print job?')) return;
        try { const r = await fetch('/admin/api/ops/jobs/' + jobId + '/reprint', { method: 'POST' }); if (!r.ok) throw new Error(); alert('Job requeued. The agent will pick it up on next poll.'); closeModal(); omRefresh(); } catch (e) { alert('Reprint failed'); }
      }
      async function reprintOrder(orderId) {
        if (!confirm('Requeue all failed jobs in this order?')) return;
        try { const r = await fetch('/admin/api/ops/orders/' + orderId + '/reprint', { method: 'POST' }); const data = await r.json(); if (!r.ok) throw new Error(); alert('Requeued ' + data.count + ' job(s). The agent will pick them up.'); closeModal(); omRefresh(); } catch (e) { alert('Reprint failed'); }
      }
      async function previewReceipt(orderId) {
        try {
          const r = await fetch('/admin/api/ops/orders/' + orderId + '/receipt-preview');
          const data = await r.json();
          if (!r.ok) throw new Error();
          const send = confirm('Receipt preview:\\n\\n' + data.text + '\\n\\n\\nSend this to the customer via WhatsApp?');
          if (send) { const r2 = await fetch('/admin/api/ops/orders/' + orderId + '/send-receipt', { method: 'POST' }); const d2 = await r2.json(); alert(d2.ok ? 'Receipt sent ✓' : 'Failed to send receipt'); }
        } catch (e) { alert('Failed to preview receipt'); }
      }
      function closeModal(event) {
        if (event && event.target !== document.getElementById('modal-overlay')) return;
        document.getElementById('modal-overlay').classList.remove('open');
      }

      ${autoRefresh ? 'setInterval(omRefresh, 5000);' : ''}

      // Deep-link: ?order=ID opens that order's detail (e.g. from a bookmark or /admin redirect).
      (function () {
        const id = new URLSearchParams(location.search).get('order');
        if (id) showOrder(id);
      })();
    </script>`;
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
      return reply.status(500).send({ error: 'Failed to update' });
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
      return reply.status(500).send({ error: 'Failed to reprint' });
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
      return reply.status(500).send({ error: 'Failed to reprint' });
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
      return reply.status(500).send({ error: 'Failed to send receipt' });
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
      return reply.status(500).send({ error: 'Failed to preview' });
    }
  });

  // Get printer status (with computed staleness)
  app.get('/admin/api/ops/printers', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      return { printers: await getPrinterStatus() };
    } catch (err) {
      logger.error({ err }, 'Failed to get printer status');
      return reply.status(500).send({ error: 'Failed to load printers' });
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
      return reply.status(500).send({ error: 'Failed to load metrics' });
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
      return reply.status(500).send({ error: 'Failed to reprint' });
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
      return reply.status(500).send({ error: 'Failed to load traffic' });
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
      return reply.status(500).send({ error: 'Failed to reset jobs' });
    }
  });
}
