/**
 * Nightly backup → Backblaze B2 (audit IMP-13).
 *
 * Dumps the Postgres database (gzipped) and the qbo-tokens.json OAuth file to
 * the B2 bucket under backups/, then prunes backups older than the retention
 * window. Reuses the same B2 credentials the app already uses.
 *
 * Run from the app dir:  npx tsx scripts/backup-db.ts
 * Schedule via cron, e.g. (daily 02:30):
 *   30 2 * * * cd /home/fusionprints/app && /usr/bin/npx tsx scripts/backup-db.ts >> /var/log/fp-backup.log 2>&1
 *
 * REMAINING (needs prod access, not automatable from here):
 *   - confirm/enable Hetzner's own snapshot cadence as a second layer
 *   - run a real restore drill (pg_restore into a scratch DB) and document it
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

const RETENTION_DAYS = 30;
const QBO_TOKEN_FILE = './qbo-tokens.json';

const s3 = new S3Client({
  endpoint: `https://${env.B2_ENDPOINT}`,
  region: 'auto',
  credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APPLICATION_KEY },
});

/** Stamp like 2026-06-14T0230 — sortable, lexicographic prune works. */
function stamp(): string {
  return new Date().toISOString().replace(/:\d\d\.\d+Z$/, '').replace(/:/g, '');
}

/** pg_dump the database to a gzipped Buffer (custom plain SQL, gzip-compressed). */
async function dumpDatabase(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', env.DATABASE_URL], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    let stderr = '';

    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    dump.stdout.pipe(gzip);
    gzip.on('data', (c: Buffer) => chunks.push(c));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
    dump.on('error', (err) => reject(new Error(`pg_dump failed to start: ${err.message} (is pg_dump installed?)`)));
    dump.on('close', (code) => {
      if (code !== 0) reject(new Error(`pg_dump exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function upload(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: env.B2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  logger.info({ key, bytes: body.length }, 'Backup uploaded');
}

/** Delete objects under a prefix whose lastModified is older than the window. */
async function prune(prefix: string): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: env.B2_BUCKET_NAME, Prefix: prefix }));
  for (const obj of listed.Contents ?? []) {
    if (obj.Key && obj.LastModified && obj.LastModified.getTime() < cutoff) {
      await s3.send(new DeleteObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: obj.Key }));
      logger.info({ key: obj.Key }, 'Pruned old backup');
    }
  }
}

async function main(): Promise<void> {
  if (!env.B2_BUCKET_NAME || !env.B2_KEY_ID) {
    throw new Error('B2 not configured — set B2_KEY_ID/B2_APPLICATION_KEY/B2_BUCKET_NAME/B2_ENDPOINT');
  }
  const ts = stamp();

  logger.info('Starting database dump');
  const dump = await dumpDatabase();
  await upload(`backups/db/fusionprints-${ts}.sql.gz`, dump, 'application/gzip');

  if (existsSync(QBO_TOKEN_FILE)) {
    await upload(`backups/qbo/qbo-tokens-${ts}.json`, await readFile(QBO_TOKEN_FILE), 'application/json');
  } else {
    logger.warn({ path: QBO_TOKEN_FILE }, 'qbo-tokens.json not found — skipping (QBO may not be connected)');
  }

  await prune('backups/db/');
  await prune('backups/qbo/');
  logger.info({ retentionDays: RETENTION_DAYS }, 'Backup complete');
}

main().catch((err) => {
  logger.error({ err }, 'Backup failed');
  process.exit(1);
});
