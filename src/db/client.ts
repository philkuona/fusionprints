/**
 * Database client. Exports a single connection pool used everywhere.
 *
 * Why a single pool: Postgres connections are expensive to open/close.
 * One pool, shared across the app, with a sensible max connection count.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/config/env.js';
import * as schema from './schema.js';

// The underlying postgres-js connection. Configure max connections sensibly
// for a small VPS — Postgres default max is 100, we use far less to leave
// room for psql sessions, migrations, etc.
const client = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });

export { schema };

/**
 * Gracefully close the DB pool. Call this on process shutdown.
 */
export async function closeDatabase(): Promise<void> {
  await client.end();
}
