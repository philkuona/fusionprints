/**
 * FusionPrints — main entry point.
 *
 * Boots a Fastify HTTP server with:
 *   - GET /          : a friendly root page proving the server is alive
 *   - GET /health    : machine-readable health check (used by uptime monitoring)
 *
 * As we build out the system, we'll mount more routes here.
 */

import Fastify from 'fastify';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { db, closeDatabase } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { registerWhatsAppWebhook } from '@/routes/whatsapp-webhook.js';
import { registerAdminDashboard } from '@/routes/admin-dashboard.js';
import { registerAdminOps } from '@/routes/admin-ops.js';
import { registerPaymentWebhooks } from '@/routes/payment-webhooks.js';
import { registerAgentRoutes } from '@/routes/agent-api.js';
import { registerUploadRoutes } from '@/routes/upload.js';
import { registerQboRoutes } from '@/routes/qbo-auth.js';
import { registerLandingRoutes } from '@/routes/landing.js';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import { PgSessionStore, sweepExpiredSessions } from '@/utils/session-store.js';
import { registerAdminLogin } from '@/routes/admin-login.js';
import { registerWebAuthRoutes } from '@/routes/web/auth.js';
import { registerWebGoogleAuthRoutes } from '@/routes/web/google-auth.js';
import { registerWebProfileRoutes } from '@/routes/web/profile.js';
import { registerWebAddressRoutes } from '@/routes/web/addresses.js';
import { registerWebCatalogRoutes } from '@/routes/web/catalog.js';
import { registerWebPhotoRoutes } from '@/routes/web/photos.js';
import { registerWebEditorRoutes } from '@/routes/web/editor.js';
import { registerWebCheckoutRoutes } from '@/routes/web/checkout.js';
import { registerWebOrderRoutes } from '@/routes/web/orders.js';
import { registerWebImportRoutes } from '@/routes/web/imports.js';
import { startImageCleanupSchedule } from '@/services/image-cleanup.js';

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
  await app.register(cookie);
  await app.register(session, {
    secret: env.ADMIN_SESSION_SECRET || 'dev-only-not-for-production-use-pad!!',
    // Persistent store so sessions survive backend restarts (deploys/reboots),
    // instead of the default in-memory store that logged everyone out on each
    // restart. maxAge is in milliseconds; rolling renews it on every request so
    // active users stay signed in and only idle sessions expire.
    store: new PgSessionStore(),
    cookie: {
      secure: env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      sameSite: 'lax' as const,
    },
    rolling: true,
    saveUninitialized: false,
  });
  // Evict expired session rows daily (cheap; indexed on expire).
  setInterval(() => void sweepExpiredSessions(), 1000 * 60 * 60 * 24).unref();

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

  // Register admin dashboard
  await registerAdminDashboard(app);
  await registerAdminOps(app);
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
  await registerWebOrderRoutes(app);
  await registerWebImportRoutes(app);

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

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Unhandled error in main()');
  process.exit(1);
});
