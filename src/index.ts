/**
 * FusionPrints — main entry point.
 *
 * Boots a Fastify HTTP server with:
 *   - GET /          : a friendly root page proving the server is alive
 *   - GET /health    : machine-readable health check (used by uptime monitoring)
 *
 * As we build out the system, we'll mount more routes here.
 */

import Fastify, { type FastifyError } from 'fastify';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { db, closeDatabase } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { registerWhatsAppWebhook } from '@/routes/whatsapp-webhook.js';
import { registerAdminDashboard } from '@/routes/admin-dashboard.js';
import { registerAdminOps } from '@/routes/admin-ops.js';
import { registerAdminPromos } from '@/routes/admin-promos.js';
import { registerAdminPricing } from '@/routes/admin-pricing.js';
import { registerAdminLocations } from '@/routes/admin-locations.js';
import { loadAndApplyPriceOverrides } from '@/services/price-overrides.js';
import { loadAndApplyCostOverrides } from '@/services/cost-overrides.js';
import { startVirtualPrinters } from '@/services/virtual-printer.js';
import { registerPaymentWebhooks } from '@/routes/payment-webhooks.js';
import { registerAgentRoutes, reclaimStaleAgentJobs } from '@/routes/agent-api.js';
import { expireStalePendingOrders, checkMediaSwitchNeeded } from '@/services/order.js';
import { sweepOldSiteVisits, sweepExpiredUploadSessions } from '@/services/data-retention.js';
import { registerUploadRoutes } from '@/routes/upload.js';
import { registerQboRoutes } from '@/routes/qbo-auth.js';
import { registerLandingRoutes } from '@/routes/landing.js';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import { PgSessionStore, sweepExpiredSessions } from '@/utils/session-store.js';
import { registerAdminLogin } from '@/routes/admin-login.js';
import { registerAdminFonts } from '@/routes/admin-fonts.js';
import { registerWebAuthRoutes } from '@/routes/web/auth.js';
import { registerWebGoogleAuthRoutes } from '@/routes/web/google-auth.js';
import { registerWebProfileRoutes } from '@/routes/web/profile.js';
import { registerWebAddressRoutes } from '@/routes/web/addresses.js';
import { registerWebCatalogRoutes } from '@/routes/web/catalog.js';
import { registerWebPhotoRoutes } from '@/routes/web/photos.js';
import { registerWebEditorRoutes } from '@/routes/web/editor.js';
import { registerWebCheckoutRoutes } from '@/routes/web/checkout.js';
import { registerPayonifyWebhook } from '@/routes/web/payonify-webhook.js';
import { registerWebOrderRoutes } from '@/routes/web/orders.js';
import { registerWebImportRoutes } from '@/routes/web/imports.js';
import { startImageCleanupSchedule } from '@/services/image-cleanup.js';
import { registerBrandFonts } from '@/utils/fonts.js';

// Make bundled brand fonts available to Sharp/librsvg before anything renders.
registerBrandFonts();

async function main(): Promise<void> {
  const app = Fastify({
    logger: false, // we use our own logger; Fastify's would duplicate
    trustProxy: true,
  });

  // ===== Plugins =====
  const allowedOrigins = [
    'https://fusionprints.co.zw',
    'https://www.fusionprints.co.zw',
    'https://app.fusionprints.co.zw', // web app (staging → launch), shares the registrable domain
    ...(env.NODE_ENV === 'development' ? ['http://localhost:3001'] : []),
    ...(env.WEB_URL && env.WEB_URL !== 'http://localhost:3001' ? [env.WEB_URL] : []),
  ];
  await app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true, // required for cookie-based auth from the web frontend
  });
  // Cheap CSRF hardening (audit BUG-12): cookie sessions + sameSite=lax block
  // most cross-site abuse already, but state-changing browser routes should
  // also refuse a mismatched Origin. Browsers always attach Origin to
  // cross-site POSTs, so this stops them even if sameSite weakens. Exemptions:
  // the Payonify webhook (server-to-server, signature-verified, no Origin) and
  // requests with neither Origin nor Referer (curl, non-browser clients) —
  // those carry no ambient cookie risk or keep sameSite as the backstop.
  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    if (!request.url.startsWith('/web/api/')) return;
    if (request.url.startsWith('/web/api/payments/payonify/webhook')) return;
    const source = request.headers.origin ?? request.headers.referer;
    if (!source) return;
    const ok = allowedOrigins.some((o) => source === o || source.startsWith(`${o}/`));
    if (!ok) {
      logger.warn(
        { method: request.method, url: request.url, origin: source },
        'Blocked state-changing request from disallowed origin',
      );
      return reply.status(403).send({ error: 'forbidden_origin' });
    }
  });

  // Basic abuse guard (audit BUG-13): per-IP, in-memory, 300 req/min default;
  // auth endpoints carry a tighter per-route limit (see routes/web/auth.ts).
  // The agent API is exempt — its long-poll is high-frequency by design and
  // already API-key-authenticated.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: (request) => request.url.startsWith('/api/agent/'),
  });
  await app.register(cookie);
  await app.register(session, {
    secret: env.ADMIN_SESSION_SECRET || 'dev-only-not-for-production-use-pad!!',
    // Persistent store so sessions survive backend restarts (deploys/reboots),
    // instead of the default in-memory store that logged everyone out on each
    // restart. maxAge is in milliseconds; the 30-day window runs from sign-in.
    //
    // rolling is OFF deliberately: with rolling on, the session was re-saved on
    // EVERY request, and our async (Postgres) store made that cookie write race
    // the response — landing after headers were sent it threw ERR_HTTP_HEADERS_
    // SENT mid-response, corrupting authenticated admin pages into blank/white
    // pages. With rolling off the session is only written when it actually
    // changes (sign-in), eliminating the per-request race.
    store: new PgSessionStore(),
    cookie: {
      secure: env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days from sign-in
      sameSite: 'lax' as const,
    },
    rolling: false,
    saveUninitialized: false,
  });
  // Evict expired session rows daily (cheap; indexed on expire).
  setInterval(() => void sweepExpiredSessions(), 1000 * 60 * 60 * 24).unref();

  // Re-queue print/slip jobs stuck in 'printing' (agent crashed mid-print) so
  // claimed-but-abandoned jobs recover. Every 5 min; 15-min staleness cutoff.
  setInterval(() => void reclaimStaleAgentJobs(), 1000 * 60 * 5).unref();

  // Auto-cancel abandoned checkouts (pending_payment > 24h). Hourly, plus one
  // run at boot to clear any backlog accumulated while the server was down.
  void expireStalePendingOrders();
  setInterval(() => void expireStalePendingOrders(), 1000 * 60 * 60).unref();

  // Alert ops when dye-sub jobs are stuck on the wrong loaded media (R2-9).
  // Every 5 min; self-cooldowns so it emails once per backlog, not per tick.
  setInterval(() => void checkMediaSwitchNeeded(), 1000 * 60 * 5).unref();

  // Data-retention sweeps: site_visits (180d), expired upload sessions. Daily,
  // plus one run at boot.
  void sweepOldSiteVisits();
  void sweepExpiredUploadSessions();
  setInterval(() => {
    void sweepOldSiteVisits();
    void sweepExpiredUploadSessions();
  }, 1000 * 60 * 60 * 24).unref();

  // Diagnostics: log any failing response (>=400) and any handler error.
  // onResponse runs AFTER the response is sent, so it only reads — it can never
  // touch already-sent headers (unlike the onSend hook that crash-looped).
  // Bot scanners probing for leaked configs / admin panels flood the 404 log
  // (audit IMP-10) — drop their noise, keep every other failing response.
  const SCANNER_PATHS = /\.(php\d?|env[^/]*|ya?ml|asp[x]?|cgi|sql|bak|ini)(\?|$)|\/(wp-|wordpress|owa|autodiscover|phpmyadmin|cgi-bin|\.git|docker-compose|actuator|telescope|solr|HNAP1)/i;
  app.addHook('onResponse', async (request, reply) => {
    // Skip the agent long-poll's expected "no job right now" 404s (high volume).
    if (reply.statusCode >= 400 && !request.url.includes('/agent/jobs/next')) {
      if (reply.statusCode === 404 && SCANNER_PATHS.test(request.url)) return;
      logger.warn({ method: request.method, url: request.url, status: reply.statusCode }, 'HTTP error response');
    }
  });
  app.setErrorHandler((err: FastifyError, request, reply) => {
    // Errors that carry their own client status (rate-limit 429s, body-parse
    // 4xx) must keep it — flattening them to 500 hides the real signal.
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      logger.error({ err, method: request.method, url: request.url }, 'Request handler error');
    }
    if (!reply.sent) {
      reply.status(status).send(
        status >= 500 ? { error: 'Internal Server Error' } : { error: err.message },
      );
    }
  });

  // ===== Routes =====

  app.get('/', async () => {
    return {
      service: env.BUSINESS_NAME,
      status: 'running',
      message: 'Hello from FusionPrints.',
    };
  });

  app.get('/health', async (_req, reply) => {
    // Real health check: can we talk to the database?
    try {
      await db.execute(sql`SELECT 1`);
      return { status: 'ok', database: 'connected' };
    } catch (err) {
      logger.error({ err }, 'Health check failed: database unreachable');
      reply.status(503);
      return { status: 'degraded', database: 'unreachable' };
    }
  });

  // Register WhatsApp webhook routes
  await registerWhatsAppWebhook(app);

  await registerAdminLogin(app);
  await registerAdminFonts(app);

  // Register admin dashboard
  await registerAdminDashboard(app);
  await registerAdminOps(app);
  await registerAdminPromos(app);
  await registerAdminPricing(app);
  await registerAdminLocations(app);
  await registerPaymentWebhooks(app);

  // Register print agent API routes
  await registerAgentRoutes(app);

  // Register landing page routes (waitlist + tracking)
  await registerLandingRoutes(app);

  // Register QBO OAuth + admin routes
  await registerQboRoutes(app);

  // Register web upload routes (for bulk photo uploads)
  await registerUploadRoutes(app);

  // Register web platform routes
  await registerWebAuthRoutes(app);
  await registerWebGoogleAuthRoutes(app);
  await registerWebProfileRoutes(app);
  await registerWebAddressRoutes(app);
  await registerWebCatalogRoutes(app);
  await registerWebPhotoRoutes(app);
  await registerWebEditorRoutes(app);
  await registerWebCheckoutRoutes(app);
  await registerPayonifyWebhook(app);
  await registerWebOrderRoutes(app);
  await registerWebImportRoutes(app);

  // Apply admin price + cost overrides onto the in-memory catalog before serving.
  await loadAndApplyPriceOverrides();
  await loadAndApplyCostOverrides();

  // ===== Start the server =====

  try {
    // In production, only listen on localhost — Nginx is the public-facing
    // reverse proxy that handles TLS and forwards to us. In dev (WSL),
    // we bind to all interfaces so you can hit the server from Windows.
    const host = env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';
    const address = await app.listen({
      port: env.PORT,
      host,
    });
    logger.info(`🚀 Server listening on ${address}`);
    logger.info(`📍 Environment: ${env.NODE_ENV}`);
    logger.info(`💾 Database: ${env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
    logger.info(`🏥 Health check: ${address}/health`);

    // Start the daily image-expiry cleanup (Phase 2.1.6). Safe by default:
    // dry-run unless IMAGE_CLEANUP_DRY_RUN=false. Timers are unref-ed.
    startImageCleanupSchedule();

    // Virtual printers (service virtualisation) — off unless VIRTUAL_PRINTERS=true.
    startVirtualPrinters(`http://127.0.0.1:${env.PORT}`);
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }

  // ===== Graceful shutdown =====

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await app.close();
      await closeDatabase();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Last-resort crash handlers (audit IMP-7): a stray rejection or throw must
// not leave the process half-dead. Log fatal and exit — systemd restarts us.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection — exiting');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Unhandled error in main()');
  process.exit(1);
});
