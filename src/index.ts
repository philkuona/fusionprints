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
import { registerAgentRoutes } from '@/routes/agent-api.js';
import { registerUploadRoutes } from '@/routes/upload.js';

async function main(): Promise<void> {
  const app = Fastify({
    logger: false, // we use our own logger; Fastify's would duplicate
    trustProxy: true,
  });

  // ===== Routes =====

  app.get('/', async () => {
    return {
      service: env.BUSINESS_NAME,
      status: 'running',
      message: 'Hello from FusionPrints. The bot lives here.',
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

  // Register admin dashboard
  await registerAdminDashboard(app);
  await registerAdminOps(app);

  // Register print agent API routes
  await registerAgentRoutes(app);

  // Register web upload routes (for bulk photo uploads)
  await registerUploadRoutes(app);

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
