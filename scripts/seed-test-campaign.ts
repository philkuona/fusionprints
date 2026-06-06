/**
 * One-off: seed an active TEST promo campaign pointing at the placeholder PNGs
 * already uploaded to B2 (scripts/upload-test-promos.ts). Run on the SERVER
 * (prod DB) after deploy:
 *
 *   ssh fusionprints@<host> 'cd /home/fusionprints/app && npx tsx scripts/seed-test-campaign.ts'
 *
 * Idempotent: deactivates any other campaign and upserts a single active test
 * campaign by name. Replaced by a real campaign (via admin) before launch.
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { promoCampaigns, type PromoSlot } from '../src/db/schema.js';

const NAME = 'TEST — launch promos';

const slot1: PromoSlot = {
  kind: 'referral',
  imageKey: 'campaigns/test-referral.png',
  headline: 'Give prints, get prints.',
  body: 'Free 4x6 pack each when a friend orders.',
  cta: 'WhatsApp or fusionprints.co.zw',
};
const slot2: PromoSlot = {
  kind: 'upsell',
  imageKey: 'campaigns/test-upsell.png',
  headline: 'Print it bigger.',
  body: '11x14 $10 · 16x20 $22',
  cta: 'WhatsApp or fusionprints.co.zw',
};

async function main() {
  // Only one active campaign at a time.
  await db.update(promoCampaigns).set({ active: false });

  const [existing] = await db
    .select()
    .from(promoCampaigns)
    .where(eq(promoCampaigns.name, NAME))
    .limit(1);

  let id: string;
  if (existing) {
    await db
      .update(promoCampaigns)
      .set({ active: true, slot1, slot2, updatedAt: new Date() })
      .where(eq(promoCampaigns.id, existing.id));
    id = existing.id;
    console.log('updated existing test campaign', id);
  } else {
    const [created] = await db
      .insert(promoCampaigns)
      .values({ name: NAME, active: true, slot1, slot2 })
      .returning({ id: promoCampaigns.id });
    id = created.id;
    console.log('inserted test campaign', id);
  }

  const [row] = await db.select().from(promoCampaigns).where(eq(promoCampaigns.id, id)).limit(1);
  console.log('active campaign now:', {
    id: row.id,
    name: row.name,
    active: row.active,
    slot1: row.slot1,
    slot2: row.slot2,
  });
  console.log('DONE');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
