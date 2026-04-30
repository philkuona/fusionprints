/**
 * Run all pending database migrations.
 *
 * Usage: npm run db:migrate
 *
 * This script applies any new SQL migration files in src/db/migrations/.
 * Drizzle tracks which migrations have been applied so this is idempotent —
 * running it twice is safe.
 *
 * To create a new migration after changing schema.ts:
 *   npx drizzle-kit generate
 * Then run this script to apply it.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

async function runMigrations(): Promise<void> {
  logger.info('Starting database migrations...');

  // Use a separate connection just for migrations (max: 1)
  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
  const migrationDb = drizzle(migrationClient);

  try {
    await migrate(migrationDb, { migrationsFolder: './src/db/migrations' });
    logger.info('✅ Migrations completed successfully');
  } catch (err) {
    logger.error({ err }, '❌ Migration failed');
    process.exit(1);
  } finally {
    await migrationClient.end();
  }
}

runMigrations().catch((err: unknown) => {
  logger.fatal({ err }, 'Unhandled migration error');
  process.exit(1);
});
