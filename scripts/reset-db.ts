/**
 * Drop and recreate the database. DEV ONLY.
 *
 * Usage: npm run db:reset
 *
 * This is destructive — it wipes everything. Refuses to run in production.
 * Useful when iterating on schema and you want a clean slate.
 *
 * After running: npm run db:migrate && npm run db:seed
 */

import postgres from 'postgres';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

async function reset(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    logger.fatal('❌ Refusing to reset database in production');
    process.exit(1);
  }

  logger.warn('⚠️  About to drop all tables...');

  const client = postgres(env.DATABASE_URL, { max: 1 });

  try {
    // Drop and recreate the public schema — fastest way to wipe everything
    await client`DROP SCHEMA public CASCADE`;
    await client`CREATE SCHEMA public`;
    await client`GRANT ALL ON SCHEMA public TO public`;
    logger.info('✅ Database reset complete');
    logger.info('Now run: npm run db:migrate && npm run db:seed');
  } catch (err) {
    logger.error({ err }, '❌ Reset failed');
    process.exit(1);
  } finally {
    await client.end();
  }
}

reset().catch((err: unknown) => {
  logger.fatal({ err }, 'Unhandled reset error');
  process.exit(1);
});
