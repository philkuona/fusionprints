/**
 * QuickBooks Online OAuth routes + admin status page.
 *
 * Routes (all full-admin only):
 *   GET  /admin/qbo              — status page
 *   GET  /admin/qbo/connect      — redirect to Intuit OAuth
 *   GET  /admin/qbo/callback     — handle OAuth callback
 *   POST /admin/qbo/setup        — run post-connect setup
 *   POST /admin/qbo/disconnect   — clear tokens
 *   GET  /admin/api/qbo/status   — JSON status (for polling)
 */

import type { FastifyInstance } from 'fastify';
import { requireFullAdminPage, requireFullAdmin } from '@/utils/auth.js';
import { logger } from '@/utils/logger.js';
import { ADMIN_FONT_CSS } from '@/routes/admin-fonts.js';
import {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  runSetup,
  disconnect,
  getStatus,
  isEnabled,
} from '@/services/qbo.js';

// ── Admin page HTML ────────────────────────────────────────────────────────

function qboPageHtml(status: ReturnType<typeof getStatus>): string {
  const connected = status.connected;
  const setupDone = status.setupComplete;

  function fmtDate(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-ZW', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QuickBooks — FusionPrints Admin</title>
  <style>
    ${ADMIN_FONT_CSS}
    :root {
      --bg: #0a0a0a; --surface: #141414; --surface2: #1e1e1e;
      --border: #2a2a2a; --text: #f0f0f0; --text2: #888;
      --accent: #f97316; --green: #22c55e; --red: #ef4444; --amber: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    header {
      display: flex; align-items: center; padding: 14px 24px;
      border-bottom: 1px solid var(--border); background: var(--surface);
      position: sticky; top: 0; z-index: 100;
    }
    .logo { display: inline-flex; align-items: center; gap: 8px; }
    .logo svg { display: block; height: 36px; width: auto; }
    .logo .admin-tag {
      font-family: 'DM Mono', monospace; font-size: 10px; font-weight: 500;
      color: var(--text2); text-transform: uppercase; letter-spacing: 1px;
      padding: 2px 6px; border: 1px solid var(--border); border-radius: 3px;
    }
    nav { display: flex; gap: 2px; flex: 1; margin-left: 24px; }
    .nav-tab {
      padding: 8px 14px; color: var(--text2); text-decoration: none;
      font-size: 13px; font-weight: 500; border-radius: 6px; transition: all 0.15s;
    }
    .nav-tab:hover { color: var(--text); background: var(--bg); }
    .nav-tab.active { color: var(--accent); background: var(--bg); }
    main { max-width: 800px; margin: 0 auto; padding: 32px 24px; }
    .page-title { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
    .page-sub { color: var(--text2); font-size: 13px; margin-bottom: 28px; }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px; margin-bottom: 16px;
    }
    .card-title { font-size: 13px; font-weight: 600; margin-bottom: 16px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }
    .status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .dot-green { background: var(--green); }
    .dot-red { background: var(--red); }
    .dot-amber { background: var(--amber); }
    .status-label { font-size: 15px; font-weight: 500; }
    .meta-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .meta-row:last-child { border-bottom: none; }
    .meta-label { color: var(--text2); }
    .meta-value { font-family: 'DM Mono', monospace; font-size: 12px; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 9px 16px; border-radius: 7px; border: 1px solid var(--border);
      background: var(--surface2); color: var(--text); font-family: inherit;
      font-size: 13px; font-weight: 500; cursor: pointer; text-decoration: none;
      transition: all 0.15s;
    }
    .btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn-primary { background: var(--accent); border-color: var(--accent); color: #000; }
    .btn-primary:hover { opacity: 0.88; color: #000; }
    .btn-danger { background: var(--red); border-color: var(--red); color: #fff; }
    .btn-danger:hover { opacity: 0.88; color: #fff; }
    .btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .info-box {
      background: rgba(249,115,22,0.08); border: 1px solid rgba(249,115,22,0.25);
      border-radius: 8px; padding: 12px 14px; font-size: 13px;
      color: #fdba74; margin-bottom: 16px; line-height: 1.5;
    }
    #setup-result { display: none; margin-top: 12px; padding: 10px 14px; border-radius: 7px; font-size: 13px; }
    .result-ok { background: rgba(34,197,94,0.1); border: 1px solid var(--green); color: var(--green); }
    .result-err { background: rgba(239,68,68,0.1); border: 1px solid var(--red); color: var(--red); }
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
      <text x="56" y="40" font-family="Outfit, system-ui, sans-serif" font-size="28" font-weight="700" fill="#FBF7F0" letter-spacing="-0.56">fusionprints</text>
    </svg>
    <span class="admin-tag">admin</span>
  </div>
  <nav>
    <a href="/admin/jobs"     class="nav-tab">Order Management</a>
    <a href="/admin/printers" class="nav-tab">Printers</a>
    <a href="/admin/metrics"  class="nav-tab">Key Metrics</a>
    <a href="/admin/promos"   class="nav-tab">Promos</a>
    <a href="/admin/pricing"  class="nav-tab">Pricing</a>
    <a href="/admin/qbo"      class="nav-tab active">QuickBooks</a>
  </nav>
</header>
<main>
  <div class="page-title">QuickBooks Online</div>
  <div class="page-sub">Automatic accounting — Sales Receipts post when orders are fulfilled, Refund Receipts post when paid orders are cancelled.</div>

  ${!isEnabled() ? `
  <div class="info-box">
    QBO integration is not configured. Add <strong>QBO_CLIENT_ID</strong> and <strong>QBO_CLIENT_SECRET</strong> to the production .env, then restart the server.
  </div>` : ''}

  <!-- Connection status -->
  <div class="card">
    <div class="card-title">Connection</div>
    <div class="status-row">
      <div class="dot ${connected ? 'dot-green' : 'dot-red'}"></div>
      <div class="status-label">${connected ? 'Connected to QuickBooks' : 'Not connected'}</div>
    </div>
    ${connected ? `
    <div class="meta-row">
      <span class="meta-label">Company (Realm ID)</span>
      <span class="meta-value">${status.realmId ?? '—'}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Access token expires</span>
      <span class="meta-value">${fmtDate(status.accessTokenExpiresAt)}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Refresh token expires</span>
      <span class="meta-value">${fmtDate(status.refreshTokenExpiresAt)}</span>
    </div>` : `
    <p style="color:var(--text2);font-size:13px;margin-bottom:4px;">
      Click Connect to authorise FusionPrints to post to your QuickBooks account.
      You will be redirected to Intuit and back.
    </p>`}
    <div class="btn-row">
      ${!connected && isEnabled() ? `<a href="/admin/qbo/connect" class="btn btn-primary">Connect to QuickBooks</a>` : ''}
      ${connected ? `
      <button class="btn btn-danger" onclick="doDisconnect()">Disconnect</button>` : ''}
    </div>
  </div>

  <!-- Setup status -->
  ${connected ? `
  <div class="card">
    <div class="card-title">Setup</div>
    <div class="status-row">
      <div class="dot ${setupDone ? 'dot-green' : 'dot-amber'}"></div>
      <div class="status-label">${setupDone ? 'Setup complete' : 'Setup required'}</div>
    </div>
    ${!setupDone ? `
    <p style="color:var(--text2);font-size:13px;margin-bottom:4px;">
      Setup finds your Chart of Accounts and creates the matching QuickBooks service items
      (Photo Print, Wall Art Print, Delivery). Run this once after connecting.
    </p>` : `
    <p style="color:var(--text2);font-size:13px;">
      Service items and accounts are mapped. Sales Receipts will post automatically on order fulfilment.
    </p>`}
    <div class="btn-row">
      <button class="btn ${setupDone ? '' : 'btn-primary'}" onclick="doSetup()" id="setup-btn">
        ${setupDone ? 'Re-run Setup' : 'Run Setup'}
      </button>
    </div>
    <div id="setup-result"></div>
  </div>` : ''}

  <!-- How it works -->
  <div class="card">
    <div class="card-title">How it works</div>
    <div class="meta-row"><span class="meta-label">Order fulfilled</span><span class="meta-value">Sales Receipt posted to QBO</span></div>
    <div class="meta-row"><span class="meta-label">Paid order cancelled</span><span class="meta-value">Refund Receipt posted to QBO</span></div>
    <div class="meta-row"><span class="meta-label">Failed post</span><span class="meta-value">Logged, order not affected — manual entry needed</span></div>
    <div class="meta-row"><span class="meta-label">Payment method</span><span class="meta-value">EcoCash / Stripe / Cash mapped to correct QBO account</span></div>
    <div class="meta-row"><span class="meta-label">Customer in QBO</span><span class="meta-value">Generic "FusionPrints Customer" (not per-customer)</span></div>
  </div>
</main>
<script>
  async function doSetup() {
    const btn = document.getElementById('setup-btn');
    const result = document.getElementById('setup-result');
    btn.disabled = true;
    btn.textContent = 'Running setup...';
    result.style.display = 'none';
    try {
      const res = await fetch('/admin/qbo/setup', { method: 'POST' });
      const data = await res.json();
      result.style.display = 'block';
      if (res.ok && data.ok) {
        result.className = 'result-ok';
        result.textContent = 'Setup complete. Accounts and items mapped successfully.';
        setTimeout(() => location.reload(), 1500);
      } else {
        result.className = 'result-err';
        result.textContent = 'Setup failed: ' + (data.error ?? 'Unknown error');
        btn.disabled = false;
        btn.textContent = 'Retry Setup';
      }
    } catch (e) {
      result.style.display = 'block';
      result.className = 'result-err';
      result.textContent = 'Connection error. Try again.';
      btn.disabled = false;
      btn.textContent = 'Retry Setup';
    }
  }

  async function doDisconnect() {
    if (!confirm('Disconnect from QuickBooks? Future fulfilled orders will not auto-post until you reconnect.')) return;
    await fetch('/admin/qbo/disconnect', { method: 'POST' });
    location.reload();
  }
</script>
</body>
</html>`;
}

// ── Route registration ─────────────────────────────────────────────────────

export async function registerQboRoutes(app: FastifyInstance): Promise<void> {

  // Status page
  app.get('/admin/qbo', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    const status = getStatus();
    return reply.type('text/html').send(qboPageHtml(status));
  });

  // Redirect to Intuit OAuth
  app.get('/admin/qbo/connect', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    const state = Math.random().toString(36).slice(2);
    const url = getAuthorizationUrl(state);
    return reply.redirect(url);
  });

  // OAuth callback
  app.get('/admin/qbo/callback', async (request, reply) => {
    if (!requireFullAdminPage(request, reply)) return;
    const { code, realmId, error } = request.query as {
      code?: string;
      realmId?: string;
      error?: string;
    };

    if (error || !code || !realmId) {
      logger.error({ error, code: !!code, realmId }, 'QBO OAuth callback failed');
      return reply.redirect('/admin/qbo?error=oauth_failed');
    }

    try {
      await exchangeCodeForTokens(code, realmId);
      logger.info({ realmId }, 'QBO OAuth connected');
      return reply.redirect('/admin/qbo');
    } catch (err) {
      logger.error({ err }, 'QBO token exchange failed');
      return reply.redirect('/admin/qbo?error=token_exchange_failed');
    }
  });

  // Run setup
  app.post('/admin/qbo/setup', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    try {
      await runSetup();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err }, 'QBO setup failed');
      return reply.status(500).send({ ok: false, error: msg });
    }
  });

  // Disconnect
  app.post('/admin/qbo/disconnect', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    disconnect();
    logger.info('QBO disconnected');
    return { ok: true };
  });

  // JSON status (for future dashboard widget)
  app.get('/admin/api/qbo/status', async (request, reply) => {
    if (!requireFullAdmin(request, reply)) return;
    return getStatus();
  });
}
