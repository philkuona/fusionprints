/**
 * Manually run the image-expiry cleanup once and exit.
 *
 * Usage:
 *   npm run cleanup:images            # dry-run — logs what WOULD be deleted
 *   npm run cleanup:images -- --execute   # actually delete expired images
 *
 * Dry-run is the default regardless of the IMAGE_CLEANUP_DRY_RUN env var, so
 * running this by hand can never delete unless you explicitly pass --execute.
 * Useful for ad-hoc cleanup or wiring to an OS-level cron.
 */

import { cleanupExpiredImages } from '../src/services/image-cleanup.js';
import { closeDatabase } from '../src/db/client.js';
import { logger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const dryRun = !execute;

  logger.info({ dryRun }, dryRun ? 'Image cleanup: DRY-RUN (pass --execute to delete)' : 'Image cleanup: EXECUTE');

  const result = await cleanupExpiredImages({ dryRun });

  logger.info(
    result,
    dryRun ? '✅ Dry-run complete (nothing deleted)' : '✅ Cleanup complete',
  );

  await closeDatabase();
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, '❌ cleanup-images failed');
  process.exit(1);
});
