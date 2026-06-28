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
import { adminShell } from '@/routes/admin-theme.js';
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
  resendReceipt,
  getActiveOrders,
  getCompletedOrdersList,
  getCancelledOrdersList,
  type Tally,
} from '@/services/admin-ops.js';
import {
  resendDispatch,
  dispatchToPartner,
  markOutsourceReceived,
  markDispatchManuallyFulfilled,
} from '@/services/outsource-dispatch.js';
import { checkAndAdvanceToPrinted } from '@/services/order.js';

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
// Theme + header/nav come from the shared brand module (admin-theme.ts); each
// page below contributes only its own page-specific styles.

function pageHtml(
  active: 'orders' | 'metrics' | 'printers' | 'jobs',
  title: string,
  body: string,
  role: AdminRole = 'full',
): string {
  return adminShell({ active, title, body, role });
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
    .ops-card .v.blue { color:var(--blue); } .ops-card .v.yellow { color:var(--amber); } .ops-card .v.orange { color:var(--accent-deep); }
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
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px;">
          <div class="card">
            <div class="muted">Revenue</div>
            <div style="font-size:26px;font-weight:600;margin-top:4px;">\${fmtMoney(d.revenue.totalUsd)}</div>
            <div class="muted">\${d.revenue.orderCount} orders</div>
          </div>
          <div class="card">
            <div class="muted">Gross margin</div>
            \${d.cost && d.cost.totalUsd > 0
              ? '<div style="font-size:26px;font-weight:600;margin-top:4px;">' + d.cost.marginPct + '%</div><div class="muted">' + fmtMoney(d.cost.marginUsd) + ' after ' + fmtMoney(d.cost.totalUsd) + ' cost</div>'
              : '<div style="font-size:26px;font-weight:600;margin-top:4px;color:var(--text2)">—</div><div class="muted">set costs in Pricing</div>'}
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
          <div class="card">
            <div class="muted">Cancelled orders</div>
            <div style="font-size:26px;font-weight:600;margin-top:4px;">\${fmtInt(d.cancellations.count)}</div>
            <div class="muted">\${fmtMoney(d.cancellations.valueUsd)} value</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;">
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
              <div title="\${d.day}: \${d.visits} visits" style="width:100%;background:var(--accent);height:\${Math.max((d.visits/max)*CHART_HEIGHT, 3)}px;border-radius:3px 3px 0 0;"></div>
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
          <div style="font-size:13px;width:54px;text-align:right;font-family:'DM Mono',monospace;">\${d.totalPrints}</div>
          <div style="font-size:13px;width:74px;text-align:right;color:var(--text2);">\${fmtMoney(d.revenue)}</div>
          <div style="font-size:13px;width:54px;text-align:right;font-family:'DM Mono',monospace;color:\${(d.cost > 0 && d.marginPct < 40) ? 'var(--red)' : 'var(--text2)'};">\${d.cost > 0 ? d.marginPct + '%' : '—'}</div>
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

    function inkHtml(p) {
      if (p.type !== 'inkjet') {
        return '<div class="muted" style="margin-top:14px;font-size:12px;">Dye-sub — ribbon based, no ink levels.</div>';
      }
      if (!p.inkLevels || !p.inkLevels.length) {
        return '<div class="muted" style="margin-top:14px;font-size:12px;">Ink levels: unknown — reported once the printer is online.</div>';
      }
      var bars = p.inkLevels.map(function(ink) {
        var pct = (typeof ink.pct === 'number' && ink.pct >= 0) ? ink.pct : null;
        var low = pct !== null && pct <= 15;
        var swatch = ink.colorHex || '#8a7b66';
        return '<div style="margin-top:8px;">'
          + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">'
          +   '<span style="display:flex;align-items:center;gap:6px;"><span style="width:9px;height:9px;border-radius:2px;background:'+swatch+';border:1px solid rgba(0,0,0,.15);"></span>'+ink.name+'</span>'
          +   '<span class="mono" style="color:'+(low?'var(--red)':'var(--text2)')+';">'+(pct===null?'—':pct+'%')+'</span>'
          + '</div>'
          + '<div style="height:6px;border-radius:999px;background:var(--surface2);overflow:hidden;">'
          +   '<div style="height:100%;width:'+(pct===null?0:pct)+'%;background:'+(low?'var(--red)':swatch)+';"></div>'
          + '</div></div>';
      }).join('');
      return '<div style="margin-top:16px;"><div class="muted" style="font-size:11px;margin-bottom:2px;">Ink levels</div>'+bars+'</div>';
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

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:14px;margin-top:16px;">
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

          \${inkHtml(p)}

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
      const n = pending || 0;
      const plural = n === 1 ? 'print' : 'prints';
      const is5x7 = mode === '5x7';
      const hot = !is5x7 && n > 0;

      let icon, cls, status;
      if (is5x7) {
        icon = '⏸️'; cls = 'paused';
        status = '<strong>5×7 loaded</strong> — regular 4×6 / 6×8 prints are paused. Print the held batch, then switch back to 6×8.';
      } else if (hot) {
        icon = '🎞️'; cls = 'waiting';
        status = '<strong>6×8 loaded</strong> — regular prints running. <span class="accent">' + n + ' held 5×7 ' + plural + ' waiting — switch to 5×7 to release.</span>';
      } else {
        icon = '🎞️'; cls = 'running';
        status = '<strong>6×8 loaded</strong> — regular prints running. No 5×7 orders waiting.';
      }

      // Segmented switch. The active side is just shown (no handler); the other
      // side is clickable and calls setDnpMode (which confirms + is guarded
      // server-side against switching mid-print). Pending count rides the 5×7 side.
      const count = n > 0 ? '<span class="count">' + n + '</span>' : '';
      const seg6 = is5x7
        ? '<button class="dnp-seg" onclick="setDnpMode(\\'6x8\\')">6×8</button>'
        : '<button class="dnp-seg active">6×8</button>';
      const seg7 = is5x7
        ? '<button class="dnp-seg active amber">5×7</button>'
        : '<button class="dnp-seg" onclick="setDnpMode(\\'5x7\\')">5×7' + count + '</button>';

      bar.innerHTML =
        '<div class="dnp-bar ' + cls + '">'
        + '<div class="dnp-main"><span class="dnp-icon">' + icon + '</span>'
        +   '<div><div class="dnp-label">DNP media mode</div><div class="dnp-status">' + status + '</div></div>'
        + '</div>'
        + '<div class="dnp-toggle">' + seg6 + seg7 + '</div>'
        + '</div>';
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
    /* DNP media-mode control: status copy on the left, segmented switch on the right */
    .dnp-bar { display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;
      background:var(--surface); border:1px solid var(--border); border-left:4px solid var(--border);
      border-radius:12px; padding:15px 18px; }
    .dnp-bar.waiting { border-color:var(--accent); border-left-color:var(--accent); background:#F4FBF7; }
    .dnp-bar.paused { border-color:#E9B949; border-left-color:#E9B949; background:#FDF7EA; }
    .dnp-main { display:flex; align-items:center; gap:13px; min-width:0; }
    .dnp-icon { font-size:22px; line-height:1; flex-shrink:0; }
    .dnp-label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--text2); font-weight:700; }
    .dnp-status { font-size:14px; color:var(--text); margin-top:2px; }
    .dnp-status .accent { color:var(--accent-deep); font-weight:600; }
    /* segmented toggle */
    .dnp-toggle { display:inline-flex; background:var(--surface2); border:1px solid var(--border);
      border-radius:999px; padding:3px; gap:2px; flex-shrink:0; }
    .dnp-seg { border:none; background:transparent; cursor:pointer; font-family:'DM Mono',monospace;
      font-weight:600; font-size:13px; padding:7px 16px; border-radius:999px; color:var(--text2);
      display:inline-flex; align-items:center; gap:7px; white-space:nowrap; transition:all .15s; }
    .dnp-seg:not(.active):hover { color:var(--text); background:rgba(31,27,22,0.05); }
    .dnp-seg.active { cursor:default; background:var(--accent); color:#0a3d22; box-shadow:0 1px 2px rgba(31,27,22,0.14); }
    .dnp-seg.active.amber { background:#E9B949; color:#5c3d06; }
    .dnp-seg .count { background:var(--accent); color:#0a3d22; font-size:11px; font-weight:700;
      padding:1px 7px; border-radius:999px; line-height:1.5; }
    .dnp-seg.active .count { background:rgba(31,27,22,0.16); }
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

async function orderManagementPageHtml(tab: 'active' | 'completed' | 'cancelled', role: AdminRole): Promise<string> {
  const tabBar = `
    <div class="om-tabs">
      <a href="/admin/jobs?tab=active" class="om-tab ${tab === 'active' ? 'active' : ''}">Active</a>
      <a href="/admin/jobs?tab=completed" class="om-tab ${tab === 'completed' ? 'active' : ''}">Completed</a>
      <a href="/admin/jobs?tab=cancelled" class="om-tab ${tab === 'cancelled' ? 'active' : ''}">Cancelled</a>
      ${tab === 'active' ? '<span class="om-live"><span class="dot"></span>Live</span>' : ''}
    </div>`;

  let table: string;
  if (tab === 'cancelled') {
    const rows = await getCancelledOrdersList();
    const showTotal = role !== 'operator';
    table = `<table class="om">
      <thead><tr><th>Date</th><th>Order #</th><th>Name</th>${showTotal ? '<th>Total</th>' : ''}<th>Refund</th><th>Fulfilment</th><th></th></tr></thead>
      <tbody>${
        rows.length === 0
          ? `<tr><td colspan="${showTotal ? 7 : 6}" class="om-empty">No cancelled orders.</td></tr>`
          : rows
              .map(
                (o) => `<tr>
        <td>${omDate(o.createdAt)}</td>
        <td class="om-mono">${o.orderNumber}</td>
        <td>${o.name ?? '<span style="color:#8a7b66">—</span>'}</td>
        ${showTotal ? `<td class="om-mono">$${parseFloat(o.totalUsd).toFixed(2)}</td>` : ''}
        <td><span class="om-badge">${o.refundStatus ? o.refundStatus.replace(/_/g, ' ') : '—'}</span></td>
        <td>${o.fulfillmentMethod === 'delivery' ? '🚚 Delivery' : '🏪 Collection'}</td>
        <td><a class="om-link" href="#" onclick="showOrder('${o.id}');return false;">View</a></td>
      </tr>`,
              )
              .join('')
      }</tbody>
    </table>`;
  } else if (tab === 'completed') {
    const rows = await getCompletedOrdersList();
    // Operators don't see order amounts (consistent with the hidden Total in the
    // detail modal + the redacted revenue stats).
    const showTotal = role !== 'operator';
    table = `<table class="om">
      <thead><tr><th>Date</th><th>Order #</th><th>Name</th><th>Status</th>${showTotal ? '<th>Total</th>' : ''}<th>Fulfilment</th><th></th></tr></thead>
      <tbody>${
        rows.length === 0
          ? `<tr><td colspan="${showTotal ? 7 : 6}" class="om-empty">No completed orders.</td></tr>`
          : rows
              .map(
                (o) => `<tr>
        <td>${omDate(o.createdAt)}</td>
        <td class="om-mono">${o.orderNumber}</td>
        <td>${o.name ?? '<span style="color:#8a7b66">—</span>'}</td>
        <td><span class="om-badge">${o.status.replace(/_/g, ' ')}</span></td>
        ${showTotal ? `<td class="om-mono">$${parseFloat(o.totalUsd).toFixed(2)}</td>` : ''}
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
      /* Order Management — page-specific styles. Tokens + .badge-* status pills
         come from the shared brand theme (admin-theme.ts). */
      .om-tabs { display:flex; gap:4px; margin-bottom:16px; align-items:center; }
      .om-tab { padding:8px 18px; border-radius:8px 8px 0 0; font-weight:600; font-size:14px; color:var(--text2); text-decoration:none; border-bottom:2px solid transparent; }
      .om-tab.active { color:var(--text); border-bottom-color:var(--accent); }
      .om-live { margin-left:auto; display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text2); }
      .om-live .dot { width:7px; height:7px; border-radius:50%; background:var(--accent); animation:ompulse 2s infinite; }
      @keyframes ompulse { 0%,100%{opacity:1;} 50%{opacity:.3;} }
      table.om { width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden; font-size:14px; }
      table.om th, table.om td { text-align:left; padding:11px 13px; border-bottom:1px solid var(--border); }
      table.om th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--text2); font-weight:700; }
      .om-mono { font-family:'DM Mono',ui-monospace,monospace; }
      .om-badge { font-size:11px; text-transform:capitalize; background:var(--surface2); color:var(--text2); padding:2px 9px; border-radius:999px; }
      .om-link { color:var(--accent-deep); font-weight:600; text-decoration:none; cursor:pointer; }
      .om-btn { cursor:pointer; border:1px solid var(--danger); color:var(--danger); background:transparent; border-radius:999px; padding:5px 12px; font-size:12px; font-weight:600; }
      .om-empty { text-align:center; color:var(--text2); padding:28px; }

      /* Order detail modal */
      .modal-overlay { display:none; position:fixed; inset:0; background:rgba(31,27,22,0.45); z-index:200; align-items:center; justify-content:center; padding:24px; }
      .modal-overlay.open { display:flex; }
      .lb-overlay { display:none; position:fixed; inset:0; background:rgba(31,27,22,0.8); z-index:300; align-items:center; justify-content:center; padding:32px; }
      .lb-overlay.open { display:flex; }
      .lb-close { position:absolute; top:18px; right:22px; width:40px; height:40px; border-radius:999px; border:none; background:rgba(255,255,255,0.15); color:#fff; font-size:22px; line-height:1; cursor:pointer; transition:background .15s; }
      .lb-close:hover { background:rgba(255,255,255,0.3); }
      .lb-content { max-width:92vw; max-height:86vh; }
      .lb-content img { max-width:92vw; max-height:86vh; border-radius:6px; display:block; }
      .modal { background:var(--surface); border:1px solid var(--border); border-radius:14px; width:100%; max-width:560px; max-height:80vh; overflow-y:auto; box-shadow:0 24px 60px rgba(31,27,22,0.18); }
      .modal-header { padding:16px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
      .modal-title { font-weight:600; font-family:'DM Mono',monospace; color:var(--text); }
      .modal-close { background:none; border:none; color:var(--text2); cursor:pointer; font-size:20px; padding:0 4px; }
      .modal-body { padding:20px; }
      .detail-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border); font-size:14px; }
      .detail-row:last-child { border-bottom:none; }
      .detail-label { color:var(--text2); }
      .detail-value { font-weight:500; text-align:right; }
      .items-list { margin-top:16px; }
      .items-title { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text2); margin-bottom:8px; }
      .item-row { background:var(--surface2); border-radius:8px; padding:10px 12px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; font-size:14px; }
      .action-btn { padding:6px 12px; border-radius:999px; border:1px solid var(--border); background:transparent; color:var(--text); font-size:12px; cursor:pointer; margin-right:4px; }
      .action-btn:hover { background:var(--surface2); }
      .action-btn.approve { border-color:var(--green); color:var(--green); }
      .action-btn.ready { border-color:var(--blue); color:var(--blue); }
      .action-btn.fulfil { border-color:var(--text2); color:var(--text2); }
      .action-btn.cancel { border-color:var(--red); color:var(--red); }
      @media (max-width:768px) { .modal-overlay { padding:0; align-items:flex-end; } .modal { max-width:100%; max-height:92vh; border-radius:14px 14px 0 0; } }
    </style>
    ${tabBar}
    <div id="om-content" class="scroll-x">${table}</div>

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

    <!-- Image/sheet preview lightbox (in-page popup, not a new tab) -->
    <div class="lb-overlay" id="preview-lightbox" onclick="closePreview()">
      <button class="lb-close" onclick="closePreview()" aria-label="Close preview">×</button>
      <div class="lb-content" id="preview-lightbox-content" onclick="event.stopPropagation()"></div>
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
      function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

      // Composite "set" preview — the one photo tiled across the sheet (4/8-up).
      // widthPx controls the size (small thumb in the row, large in the lightbox).
      function compositeSheetHtml(url, c, widthPx) {
        var cells = c.cells.map(function(cell) {
          return '<div style="position:absolute;left:' + (cell.x / c.sheetWidth * 100) + '%;top:' + (cell.y / c.sheetHeight * 100) + '%;width:' + (cell.width / c.sheetWidth * 100) + '%;height:' + (cell.height / c.sheetHeight * 100) + '%;overflow:hidden;box-shadow:inset 0 0 0 0.5px rgba(0,0,0,0.3);"><img src="' + url + '" alt="" style="width:100%;height:100%;object-fit:cover;" /></div>';
        }).join('');
        var size = widthPx ? 'width:' + widthPx + 'px;' : 'height:84vh;';
        return '<div style="position:relative;' + size + 'aspect-ratio:' + c.sheetWidth + '/' + c.sheetHeight + ';background:#fff;border-radius:4px;border:1px solid var(--border);overflow:hidden;flex-shrink:0;">' + cells + '</div>';
      }
      function compositeThumb(item) {
        if (!item.composite || !item.previewUrl) return '';
        return compositeSheetHtml(item.previewUrl, item.composite, 54);
      }

      // In-page preview popup (lightbox) — used instead of opening a new tab.
      var __omPreviews = [];
      var __omSlips = [];
      function openPreview(i) {
        var p = __omPreviews[i];
        if (!p || !p.url) return;
        document.getElementById('preview-lightbox-content').innerHTML =
          p.composite ? compositeSheetHtml(p.url, p.composite, 0) : '<img src="' + p.url + '" alt="" />';
        document.getElementById('preview-lightbox').classList.add('open');
      }
      function openSlip(i) {
        var url = __omSlips[i];
        if (!url) return;
        document.getElementById('preview-lightbox-content').innerHTML = '<img src="' + url + '" alt="" />';
        document.getElementById('preview-lightbox').classList.add('open');
      }
      function closePreview() {
        document.getElementById('preview-lightbox').classList.remove('open');
        document.getElementById('preview-lightbox-content').innerHTML = '';
      }
      document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closePreview(); });

      async function showOrder(orderId) {
        document.getElementById('modal-overlay').classList.add('open');
        document.getElementById('modal-body').innerHTML = '<div class="loading">Loading...</div>';
        const res = await fetch(\`/admin/api/orders/\${orderId}\`);
        const data = await res.json();
        if (!data) { document.getElementById('modal-body').innerHTML = '<div class="empty">Order not found.</div>'; return; }
        const { order, customer, items, jobs, slips, outsource } = data;
        document.getElementById('modal-title').textContent = order.orderNumber;
        // Preview registries for the in-page lightbox (referenced by index).
        __omPreviews = items.map(it => ({ url: it.previewUrl, composite: it.composite }));
        __omSlips = (slips || []).map(s => s.previewUrl);
        const slipLabels = { end_separator:'Separator', order_info:'Order info', promo:'Promo card' };
        const slipsHtml = (slips || []).map((s, si) => \`
          <div class="item-row">
            <span style="display:flex;align-items:center;gap:10px;">
              \${s.previewUrl ? \`<span onclick="openSlip(\${si})" style="cursor:zoom-in;display:inline-flex;"><img src="\${s.previewUrl}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:4px;background:var(--surface);" /></span>\` : '<span style="width:44px;height:44px;border-radius:4px;background:var(--surface);display:inline-flex;align-items:center;justify-content:center;font-size:18px;opacity:0.4;">🪪</span>'}
              <span>\${slipLabels[s.slipType] || s.slipType}</span>
            </span>
            <span class="badge badge-\${s.status}">\${s.status}</span>
          </div>\`).join('');
        // Outsource fulfillment stream (Phase 5) — dispatch history + ops actions.
        // Only shown for orders that actually have outsourced (wall print) items.
        const osLabels = { not_applicable:'—', pending:'Pending dispatch', dispatched:'Dispatched', received:'Received', failed:'Failed' };
        const osColor = { pending:'#8A7B66', dispatched:'#2563EB', received:'#04A551', failed:'#C0392B', not_applicable:'#8A7B66' };
        let outsourceHtml = '';
        if (outsource && outsource.hasItems) {
          const dlist = (outsource.dispatches || []).map(d => \`
            <div class="item-row">
              <span style="font-size:13px;">\${esc(d.partnerName || 'No partner')}\${d.partnerShortCode ? ' ('+esc(d.partnerShortCode)+')' : ''} · \${esc(d.channel)}\${d.sentAt ? ' · '+new Date(d.sentAt).toLocaleString() : ''}\${d.errorMessage ? ' · <span style="color:#C0392B">'+esc(d.errorMessage)+'</span>' : ''}</span>
              <span class="badge" style="background:#F1ECE3;color:#4a3f32;">\${esc(d.status)}</span>
            </div>\`).join('');
          const partnerOpts = (outsource.partners || []).map(p => \`<option value="\${p.id}">\${esc(p.name)} (\${esc(p.shortCode)})</option>\`).join('');
          const sendRow = partnerOpts
            ? \`<div style="display:flex;gap:8px;margin-top:8px;"><select id="os-partner-\${order.id}" style="flex:1">\${partnerOpts}</select><button class="action-btn" onclick="outsourceSend('\${order.id}')">Send to selected</button></div>\`
            : '<div class="sub" style="margin-top:8px">No active partners — add one under Partners.</div>';
          outsourceHtml = \`
            <div class="items-list" style="margin-top:16px">
              <div class="items-title">Outsource — wall prints · <span style="color:\${osColor[outsource.status] || '#8A7B66'}">\${osLabels[outsource.status] || outsource.status}</span></div>
              \${dlist || '<div class="sub">Not dispatched yet.</div>'}
              <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
                <button class="action-btn approve" onclick="outsourceAction('\${order.id}','outsource-resend')">📤 \${outsource.status === 'failed' ? 'Retry send' : 'Re-send'}</button>
                \${outsource.status !== 'received' ? \`<button class="action-btn ready" onclick="outsourceAction('\${order.id}','outsource-received')">✓ Mark received</button>\` : ''}
                \${outsource.status !== 'received' ? \`<button class="action-btn" onclick="outsourceAction('\${order.id}','outsource-manual')">Mark manually fulfilled</button>\` : ''}
              </div>
              \${sendRow}
            </div>\`;
        }
        const itemsHtml = items.map((item, i) => \`
          <div class="item-row">
            <span style="display:flex;align-items:center;gap:10px;">
              \${item.composite && item.previewUrl
                ? \`<span onclick="openPreview(\${i})" style="cursor:zoom-in;display:inline-flex;" title="How the sheet prints">\${compositeThumb(item)}</span>\`
                : item.previewUrl
                  ? \`<span onclick="openPreview(\${i})" style="cursor:zoom-in;display:inline-flex;"><img src="\${item.previewUrl}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:4px;background:var(--surface);" /></span>\`
                  : '<span style="width:44px;height:44px;border-radius:4px;background:var(--surface);display:inline-flex;align-items:center;justify-content:center;font-size:18px;opacity:0.4;">🖼</span>'}
              <span>\${item.quantity} × \${item.sizeCode} (\${item.productType.replace('_', ' ')})\${item.composite ? ' · <span style="color:var(--accent)">' + item.composite.cells.length + ' on one sheet</span>' : ''}</span>
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
          \${order.cancellationStatus === 'requested' ? \`<div style="margin-top:14px;padding:12px 14px;background:#FCEFD9;border:1px solid #E9B949;border-radius:10px;color:#7A4E0B;font-size:13px;line-height:1.5;"><strong>⚠️ Cancellation requested by customer.</strong>\${order.cancellationReason ? ' &ldquo;' + esc(order.cancellationReason) + '&rdquo;' : ''} Approving refunds $\${parseFloat(order.totalUsd).toFixed(2)} via Payonify.</div>\` : ''}
          \${order.refundStatus === 'succeeded' ? \`<div class="detail-row"><span class="detail-label">Refunded</span><span class="detail-value">$\${parseFloat(order.refundAmountUsd || order.totalUsd).toFixed(2)}\${order.refundedAt ? ' · ' + new Date(order.refundedAt).toLocaleDateString() : ''}</span></div>\` : ''}
          \${order.refundStatus === 'failed' ? \`<div style="margin-top:14px;padding:12px 14px;background:#FBE6E2;border:1px solid #F2C4BB;border-radius:10px;color:#C0392B;font-size:13px;line-height:1.5;"><strong>Refund failed.</strong> The order was left intact — retry below, or refund manually in Payonify.</div>\` : ''}
          <div class="items-list"><div class="items-title">Items (\${items.length})</div>\${itemsHtml}</div>
          \${jobs.length > 0 ? \`<div class="items-list" style="margin-top:16px"><div class="items-title">Print jobs</div>\${jobs.map(j => \`<div class="item-row"><span>\${j.printerName || 'Unassigned'}</span><span style="display:flex;gap:8px;align-items:center;"><span class="badge badge-\${j.status}">\${j.status}</span>\${j.status === 'failed' ? \`<button class="action-btn approve" style="padding:3px 8px;font-size:11px" onclick="reprintJob('\${j.id}')">↻ Reprint</button>\` : ''}</span></div>\`).join('')}</div>\` : ''}
          \${(slips && slips.length > 0) ? \`<div class="items-list" style="margin-top:16px"><div class="items-title">Slip cards (\${slips.length})</div>\${slipsHtml}</div>\` : ''}
          \${outsourceHtml}
          <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
            \${(!IS_OPERATOR && order.cancellationStatus === 'requested') ? \`<button class="action-btn approve" onclick="doApproveCancellation('\${order.id}')">✓ Approve &amp; refund</button><button class="action-btn cancel" onclick="doDeclineCancellation('\${order.id}')">Decline request</button>\` : ''}
            \${(!IS_OPERATOR && order.refundStatus === 'failed') ? \`<button class="action-btn approve" onclick="doApproveCancellation('\${order.id}')">↻ Retry refund</button>\` : ''}
            \${order.status === 'awaiting_approval' ? \`<button class="action-btn approve" onclick="doAction('\${order.id}', 'approve'); closeModal()">✓ Approve for printing</button>\` : ''}
            \${order.status === 'printed' && order.fulfillmentMethod !== 'delivery' ? \`<button class="action-btn approve" onclick="doAction('\${order.id}', 'release-for-pickup'); closeModal()">📦 Release for pickup</button>\` : ''}
            \${order.status === 'printed' && order.fulfillmentMethod === 'delivery' ? \`<button class="action-btn approve" onclick="doOpsAction('\${order.id}', 'shipped'); closeModal()">🚚 Mark out for delivery</button>\` : ''}
            \${order.status === 'ready_for_collection' && order.fulfillmentMethod === 'delivery' ? \`<button class="action-btn ready" onclick="doOpsAction('\${order.id}', 'shipped'); closeModal()">🚚 Mark out for delivery</button>\` : ''}
            \${(order.status === 'ready_for_collection' || order.status === 'ready_for_pickup' || order.status === 'shipped') ? \`<button class="action-btn fulfil" onclick="doAction('\${order.id}', 'fulfil'); closeModal()">✓ Mark fulfilled</button>\` : ''}
            \${jobs.some(j => j.status === 'failed') ? \`<button class="action-btn approve" onclick="reprintOrder('\${order.id}')">↻ Reprint failed jobs</button>\` : ''}
            <button class="action-btn ready" onclick="resendReceipt('\${order.id}')">🔁 Resend receipt</button>
            \${(!IS_OPERATOR && !['fulfilled','cancelled','failed'].includes(order.status)) ? \`<button class="action-btn cancel" onclick="doAction('\${order.id}', 'cancel'); closeModal()">Cancel order</button>\` : ''}
          </div>\`;
      }

      async function doAction(orderId, action) {
        if (action === 'cancel' && !confirm('Cancel this order? Paid orders are refunded via Payonify.')) return;
        const r = await fetch(\`/admin/api/orders/\${orderId}/\${action}\`, { method: 'POST' });
        if (action === 'cancel') {
          const d = await r.json().catch(function(){ return {}; });
          if (!r.ok) { alert(d.message || 'Cancel failed.'); return; }
          if (d.refunded) alert('Order cancelled and refunded. The customer has been notified.');
        }
        omRefresh();
      }
      async function doApproveCancellation(orderId) {
        if (!confirm('Approve this cancellation and refund the customer via Payonify? This cannot be undone.')) return;
        try {
          const r = await fetch('/admin/api/orders/' + orderId + '/approve-cancellation', { method: 'POST' });
          const d = await r.json().catch(function(){ return {}; });
          if (!r.ok) { alert(d.message || 'Refund failed.'); return; }
          alert('Refund issued. The customer has been notified.');
          closeModal(); omRefresh();
        } catch (e) { alert('Refund failed.'); }
      }
      async function doDeclineCancellation(orderId) {
        if (!confirm('Decline this cancellation request? The order stays active and the customer is notified.')) return;
        try {
          const r = await fetch('/admin/api/orders/' + orderId + '/decline-cancellation', { method: 'POST' });
          if (!r.ok) throw new Error();
          closeModal(); omRefresh();
        } catch (e) { alert('Could not decline the request.'); }
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
      async function outsourceAction(orderId, action) {
        if (action === 'outsource-manual' && !confirm('Mark the outsourced prints as handled outside the system?')) return;
        try {
          const r = await fetch('/admin/api/ops/orders/' + orderId + '/' + action, { method: 'POST' });
          const d = await r.json().catch(function(){ return {}; });
          if (!r.ok || d.ok === false) { alert(d && d.error ? ('Failed: ' + d.error) : 'Action failed'); }
          showOrder(orderId); omRefresh();
        } catch (e) { alert('Action failed'); }
      }
      async function outsourceSend(orderId) {
        var sel = document.getElementById('os-partner-' + orderId);
        var partnerId = sel && sel.value;
        if (!partnerId) { alert('Pick a partner first'); return; }
        try {
          const r = await fetch('/admin/api/ops/orders/' + orderId + '/outsource-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partnerId: partnerId }) });
          const d = await r.json().catch(function(){ return {}; });
          if (!r.ok || d.ok === false) { alert(d && d.error ? ('Failed: ' + d.error) : 'Send failed'); }
          showOrder(orderId); omRefresh();
        } catch (e) { alert('Send failed'); }
      }
      async function resendReceipt(orderId) {
        if (!confirm('Resend the branded receipt to the customer (email + WhatsApp, whichever the order has)?')) return;
        try {
          const r = await fetch('/admin/api/ops/orders/' + orderId + '/resend-receipt', { method: 'POST' });
          const d = await r.json();
          alert(d.ok ? 'Receipt resent ✓' : 'Failed to resend receipt');
        } catch (e) { alert('Failed to resend receipt'); }
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
    const tabRaw = (request.query as { tab?: string }).tab;
    const tab = tabRaw === 'completed' ? 'completed' : tabRaw === 'cancelled' ? 'cancelled' : 'active';
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

  // ===== Outsource fulfillment-stream actions (Phase 5) =====

  // Re-send the package to the active default partner (first attempt failed/lost).
  app.post('/admin/api/ops/orders/:id/outsource-resend', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const d = await resendDispatch(id);
      return { ok: !!d && d.status === 'sent', status: d?.status ?? null, error: d?.errorMessage ?? null };
    } catch (err) {
      logger.error({ err }, 'Failed to re-send outsource dispatch');
      return reply.status(500).send({ error: 'Failed to re-send' });
    }
  });

  // Send to a specific partner (default unavailable/busy).
  app.post('/admin/api/ops/orders/:id/outsource-send', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const { partnerId } = (request.body ?? {}) as { partnerId?: string };
      if (!partnerId) return reply.status(400).send({ error: 'partnerId required' });
      const d = await dispatchToPartner(id, partnerId);
      return { ok: !!d && d.status === 'sent', status: d?.status ?? null, error: d?.errorMessage ?? null };
    } catch (err) {
      logger.error({ err }, 'Failed to send outsource dispatch to partner');
      return reply.status(500).send({ error: 'Failed to send' });
    }
  });

  // Ops confirms the partner's prints are back/ready — settles the outsource
  // stream and advances the order to 'printed' if the in-house side is also done.
  app.post('/admin/api/ops/orders/:id/outsource-received', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await markOutsourceReceived(id);
      await checkAndAdvanceToPrinted(id);
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to mark outsource received');
      return reply.status(500).send({ error: 'Failed to update' });
    }
  });

  // Ops handled the outsourced items entirely outside the system.
  app.post('/admin/api/ops/orders/:id/outsource-manual', async (request, reply) => {
    if (!checkAuth(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      await markDispatchManuallyFulfilled(id);
      await checkAndAdvanceToPrinted(id);
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to mark outsource manually fulfilled');
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

  // Resend the branded receipt to BOTH channels (R2-2) — full admin only.
  app.post('/admin/api/ops/orders/:id/resend-receipt', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      const { id } = request.params as { id: string };
      const ok = await resendReceipt(id);
      if (!ok) {
        reply.status(404).send({ error: 'Order not found' });
        return;
      }
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Failed to resend receipt');
      return reply.status(500).send({ error: 'Failed to resend receipt' });
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
