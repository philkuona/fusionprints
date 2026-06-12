/**
 * Schema drift check (audit Phase 3.3).
 *
 * Compares the live database (information_schema) against the latest drizzle
 * snapshot in src/db/migrations/meta/. Catches the "dev DB hand-edited" /
 * "migration never applied" class of drift before it bites a deploy.
 *
 * Read-only. Exits 1 if drift is found, 0 if clean — suitable for CI.
 *
 * Usage: npx tsx scripts/schema-drift-check.ts
 *        DATABASE_URL=... npx tsx scripts/schema-drift-check.ts   (other DBs)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import 'dotenv/config';

interface SnapshotColumn {
  name: string;
  type: string;
  notNull: boolean;
}
interface SnapshotTable {
  name: string;
  schema: string;
  columns: Record<string, SnapshotColumn>;
}
interface Snapshot {
  tables: Record<string, SnapshotTable>;
}

function latestSnapshot(): { file: string; snapshot: Snapshot } {
  const metaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', 'meta');
  const files = readdirSync(metaDir)
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort();
  const file = files[files.length - 1];
  if (!file) throw new Error(`No snapshot found in ${metaDir}`);
  return { file, snapshot: JSON.parse(readFileSync(join(metaDir, file), 'utf8')) as Snapshot };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const { file, snapshot } = latestSnapshot();

  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    const rows = await sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT IN ('__drizzle_migrations')
      ORDER BY table_name, column_name
    `;

    const dbCols = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const dbTables = new Set(rows.map((r) => r.table_name));

    const snapCols = new Set<string>();
    const snapTables = new Set<string>();
    for (const table of Object.values(snapshot.tables)) {
      snapTables.add(table.name);
      for (const col of Object.values(table.columns)) {
        snapCols.add(`${table.name}.${col.name}`);
      }
    }

    // drizzle's own bookkeeping table lives in schema "drizzle", but session
    // storage (connect-pg-simple style) may add tables drizzle doesn't manage.
    const UNMANAGED_TABLES = new Set(['session', 'sessions']);

    const missingInDb = [...snapCols].filter((c) => !dbCols.has(c));
    const extraInDb = [...dbCols].filter((c) => {
      const table = c.split('.')[0];
      return !snapCols.has(c) && !UNMANAGED_TABLES.has(table);
    });
    const missingTables = [...snapTables].filter((t) => !dbTables.has(t));
    const extraTables = [...dbTables].filter((t) => !snapTables.has(t) && !UNMANAGED_TABLES.has(t));

    console.log(`Snapshot: ${file}`);
    console.log(`DB: ${url.replace(/:\/\/[^@]*@/, '://***@')}`);
    console.log(`Tables — snapshot: ${snapTables.size}, db: ${dbTables.size}`);

    let drift = false;
    const report = (label: string, items: string[]): void => {
      if (items.length === 0) return;
      drift = true;
      console.log(`\n${label} (${items.length}):`);
      for (const item of items) console.log(`  - ${item}`);
    };
    report('Tables in snapshot but MISSING from DB', missingTables);
    report('Tables in DB but NOT in snapshot', extraTables);
    report('Columns in snapshot but MISSING from DB', missingInDb);
    report('Columns in DB but NOT in snapshot', extraInDb);

    if (drift) {
      console.log('\nDRIFT DETECTED — re-baseline or apply pending migrations.');
      process.exitCode = 1;
    } else {
      console.log('\nNo drift. DB matches the snapshot.');
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
