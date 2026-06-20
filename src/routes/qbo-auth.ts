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
import { adminShell } from '@/routes/admin-theme.js';
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

  const extraCss = `
    main { max-width: 800px; }
    .card-title { font-size:13px; font-weight:700; margin-bottom:16px; color:var(--text2); text-transform:uppercase; letter-spacing:.5px; }
    .status-row { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
    .dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
    .dot-green { background:var(--green); } .dot-red { background:var(--red); } .dot-amber { background:var(--amber); }
    .status-label { font-size:15px; font-weight:600; }
    .meta-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border); font-size:13px; gap:16px; }
    .meta-row:last-child { border-bottom:none; }
    .meta-label { color:var(--text2); }
    .meta-value { font-family:'DM Mono',monospace; font-size:12px; text-align:right; }
    .btn-row { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
    .info-box { background:#FCEFD9; border:1px solid #F0D9A8; border-radius:10px; padding:12px 14px; font-size:13px; color:#7A4E0B; margin-bottom:16px; line-height:1.5; }
    #setup-result { display:none; margin-top:12px; padding:10px 14px; border-radius:8px; font-size:13px; }
    .result-ok { background:#E3F7EC; border:1px solid #A7E8C4; color:#04A551; }
    .result-err { background:#FBE6E2; border:1px solid #F2C4BB; color:#C0392B; }`;

  const body = `
  <div class="page-header">
    <h1>QuickBooks Online</h1>
    <div class="sub">Automatic accounting — Sales Receipts post when an order is paid, Refund Receipts post when paid orders are cancelled.</div>
  </div>

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
    <div class="meta-row"><span class="meta-label">Payment method</span><span class="meta-value">EcoCash / Payonify / Cash mapped to correct QBO account</span></div>
    <div class="meta-row"><span class="meta-label">Customer in QBO</span><span class="meta-value">Posted under the real buyer (name + email + phone)</span></div>
  </div>
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
</script>`;
  return adminShell({ active: 'qbo', title: 'QuickBooks', body, role: 'full', extraCss });
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
