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

  // ===== Start the server =====

  try {
    const address = await app.listen({
      port: env.PORT,
      host: '0.0.0.0', // listen on all interfaces, important for WSL
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
