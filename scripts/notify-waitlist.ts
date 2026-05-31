/**
 * FusionPrints — Launch Notification Script
 *
 * Sends a WhatsApp message to everyone on the waitlist notifying them
 * that FusionPrints is now live.
 *
 * Usage (run from ~/dev/fusionprints):
 *   tsx scripts/notify-waitlist.ts
 *
 * Or on the server:
 *   cd /home/fusionprints/app && tsx scripts/notify-waitlist.ts
 *
 * Dry run (preview only, no messages sent):
 *   DRY_RUN=true tsx scripts/notify-waitlist.ts
 *
 * The script:
 *   - Fetches all waitlist entries not yet notified
 *   - Sends each a WhatsApp message
 *   - Marks them as notified in the DB
 *   - Waits 500ms between sends to avoid rate limits
 *   - Logs successes and failures
 *   - Is safe to re-run — already-notified entries are skipped
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { isNull, isNotNull } from 'drizzle-orm';
import { waitlist } from '../src/db/schema.js';
import { env } from '../src/config/env.js';

const isDryRun = process.env.DRY_RUN === 'true';
const client = postgres(env.DATABASE_URL, { max: 1 });
const db = drizzle(client);

const LAUNCH_MESSAGE = `Hi {name}! 🎉

*FusionPrints is now live in Harare!*

You signed up to be notified — and the wait is over.

Print your favourite photos straight from your phone. WhatsApp us your images, choose your size, pay, and collect. Fast, simple, beautiful prints.

👉 Send your photos to this number to get started.

_Thank you for believing in us before we launched. Hold the moment._

— The FusionPrints Team`;

async function sendWhatsApp(to: string, message: string): Promise<boolean> {
  // Strip + for 360dialog
  const toNum = to.replace(/^\+/, '');

  const res = await fetch(`${env.WHATSAPP_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'D360-API-KEY': env.WHATSAPP_API_KEY,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                toNum,
      type:              'text',
      text:              { body: message },
    }),
  });

  return res.ok;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('FusionPrints — Launch Notification Script');
  console.log(isDryRun ? '*** DRY RUN — no messages will be sent ***' : '*** LIVE RUN — messages will be sent ***');
  console.log('');

  // Fetch all unnotified entries
  const pending = await db
    .select()
    .from(waitlist)
    .where(isNull(waitlist.notifiedAt));

  if (!pending.length) {
    console.log('No unnotified waitlist entries found. All done.');
    await client.end();
    return;
  }

  console.log(`Found ${pending.length} people to notify.\n`);

  let successCount = 0;
  let failCount = 0;

  for (const entry of pending) {
    const message = LAUNCH_MESSAGE.replace('{name}', entry.name.split(' ')[0]);

    if (isDryRun) {
      console.log(`[DRY RUN] Would send to ${entry.name} (${entry.whatsapp}):`);
      console.log(message);
      console.log('---');
      successCount++;
      continue;
    }

    try {
      const ok = await sendWhatsApp(entry.whatsapp, message);

      if (ok) {
        // Mark as notified
        await db
          .update(waitlist)
          .set({ notifiedAt: new Date() })
          .where(isNotNull(waitlist.id));

        console.log(`✓ Sent to ${entry.name} (${entry.whatsapp})`);
        successCount++;
      } else {
        console.error(`✗ Failed to send to ${entry.name} (${entry.whatsapp}) — API returned error`);
        failCount++;
      }
    } catch (err) {
      console.error(`✗ Error sending to ${entry.name} (${entry.whatsapp}):`, err);
      failCount++;
    }

    // Wait between sends to avoid rate limits
    await sleep(500);
  }

  console.log('');
  console.log(`Done. ${successCount} sent, ${failCount} failed.`);
  if (failCount > 0) {
    console.log('Re-run the script to retry failed entries (already-notified entries are skipped).');
  }

  await client.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
