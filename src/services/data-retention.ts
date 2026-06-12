/**
 * Data-retention sweeps (audit Phase 3.3).
 *
 * Small daily deletes that stop unbounded table growth:
 *   - site_visits: anonymous landing-page analytics, kept 180 days.
 *   - upload_sessions: single-use, expire after 1 hour; rows are kept a day
 *     past expiry for debugging, then purged.
 *
 * Both are best-effort: a failure logs and returns 0, never throws.
 */

import { lt } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { siteVisits, uploadSessions } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SITE_VISITS_RETENTION_DAYS = 180;

/** Delete site_visits rows older than the retention window. */
export async function sweepOldSiteVisits(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - SITE_VISITS_RETENTION_DAYS * DAY_MS);
    const deleted = await db
      .delete(siteVisits)
      .where(lt(siteVisits.visitedAt, cutoff))
      .returning({ id: siteVisits.id });
    if (deleted.length > 0) {
      logger.info({ count: deleted.length, retentionDays: SITE_VISITS_RETENTION_DAYS }, 'Swept old site visits');
    }
    return deleted.length;
  } catch (err) {
    logger.error({ err }, 'Failed to sweep old site visits');
    return 0;
  }
}

/** Delete upload_sessions rows expired for more than a day. */
export async function sweepExpiredUploadSessions(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - DAY_MS);
    const deleted = await db
      .delete(uploadSessions)
      .where(lt(uploadSessions.expiresAt, cutoff))
      .returning({ id: uploadSessions.id });
    if (deleted.length > 0) {
      logger.info({ count: deleted.length }, 'Swept expired upload sessions');
    }
    return deleted.length;
  } catch (err) {
    logger.error({ err }, 'Failed to sweep expired upload sessions');
    return 0;
  }
}
