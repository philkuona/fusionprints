/**
 * Image expiry cleanup (Phase 2.1.6).
 *
 * Web uploads are kept for 90 days (see storeWebImage), tracked by the
 * `delete_after` timestamp on the images row. This job finds web-owned images
 * whose retention window has passed and removes them from B2 + the database.
 *
 * Safety rules:
 *   - Scoped to WEB uploads (web_user_id set). WhatsApp images have their own
 *     (currently un-automated) lifecycle and are left untouched here.
 *   - Images still referenced by an order_item are SKIPPED. That FK has no
 *     cascade, and an order must keep its source image regardless of age.
 *   - Dry-run mode logs the full deletion list and deletes nothing — the
 *     default, so the job is safe until a human flips IMAGE_CLEANUP_DRY_RUN.
 */

import { and, lt, isNotNull, notInArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { images, orderItems } from '@/db/schema.js';
import { deleteImage } from '@/services/image-storage.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

export interface CleanupResult {
  dryRun: boolean;
  found: number;
  deleted: number;
  failed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between an expiry timestamp and now (how overdue a row is). */
function daysOverdue(deleteAfter: Date, now: Date): number {
  return Math.floor((now.getTime() - deleteAfter.getTime()) / DAY_MS);
}

/**
 * Find and remove expired web-owned images.
 *
 * @param dryRun - when true, log the deletion list but delete nothing.
 */
export async function cleanupExpiredWebImages({
  dryRun,
}: {
  dryRun: boolean;
}): Promise<CleanupResult> {
  const now = new Date();

  // Image ids referenced by any order item — protected from deletion.
  const referenced = db.select({ id: orderItems.imageId }).from(orderItems);

  const expired = await db
    .select({
      id: images.id,
      webUserId: images.webUserId,
      storageKey: images.storageKey,
      deleteAfter: images.deleteAfter,
    })
    .from(images)
    .where(
      and(
        isNotNull(images.webUserId),
        isNotNull(images.deleteAfter),
        lt(images.deleteAfter, now),
        notInArray(images.id, referenced),
      ),
    );

  const result: CleanupResult = {
    dryRun,
    found: expired.length,
    deleted: 0,
    failed: 0,
  };

  if (expired.length === 0) {
    logger.info({ dryRun }, 'Image cleanup: no expired web images');
    return result;
  }

  // Always log the list so dry-runs produce a reviewable deletion manifest.
  logger.info(
    {
      dryRun,
      count: expired.length,
      images: expired.map((img) => ({
        id: img.id,
        webUserId: img.webUserId,
        storageKey: img.storageKey,
        daysOverdue: img.deleteAfter ? daysOverdue(img.deleteAfter, now) : null,
      })),
    },
    dryRun
      ? 'Image cleanup DRY-RUN — these expired web images WOULD be deleted'
      : 'Image cleanup — deleting expired web images',
  );

  if (dryRun) return result;

  for (const img of expired) {
    try {
      await deleteImage(img.id);
      result.deleted += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({ err, imageId: img.id }, 'Image cleanup: failed to delete');
    }
  }

  logger.info(
    { found: result.found, deleted: result.deleted, failed: result.failed },
    'Image cleanup complete',
  );
  return result;
}

let scheduled = false;

/**
 * Start the in-process daily cleanup scheduler.
 *
 * Runs once shortly after boot, then every 24h. Timers are `unref`-ed so they
 * never hold the process open during shutdown. No-ops if disabled via env or
 * if already started (guards against double-registration).
 */
export function startImageCleanupSchedule(): void {
  if (!env.IMAGE_CLEANUP_ENABLED) {
    logger.info('Image cleanup scheduler disabled (IMAGE_CLEANUP_ENABLED=false)');
    return;
  }
  if (scheduled) return;
  scheduled = true;

  const dryRun = env.IMAGE_CLEANUP_DRY_RUN;
  logger.info({ dryRun, intervalHours: 24 }, 'Image expiry cleanup scheduled');

  const run = (): void => {
    void cleanupExpiredWebImages({ dryRun }).catch((err: unknown) =>
      logger.error({ err }, 'Image cleanup run failed'),
    );
  };

  // First pass a minute after boot (let the server settle), then daily.
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, DAY_MS).unref();
}
