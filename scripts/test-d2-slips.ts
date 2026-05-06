/**
 * D.2 smoke test — trigger markOrderPaid() for an existing order
 * and verify slip jobs are queued correctly.
 *
 * Usage: npx tsx scripts/test-d2-slips.ts FP-2026-XXXX
 *
 * What it does:
 *   1. Calls markOrderPaid(orderNumber, 'TEST-D2-SMOKE')
 *   2. Queries slip_jobs to confirm 3 rows were inserted
 *   3. Reports each slip's status and URL/payload
 *
 * Safe to run against a test order. If you re-run on the same order,
 * it will queue ANOTHER 3 slips (no dedup). That's fine for testing.
 */

import { markOrderPaid } from '../src/services/order.js';
import { db, closeDatabase } from '../src/db/client.js';
import { slipJobs, orders } from '../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

async function main(): Promise<void> {
  const orderNumber = process.argv[2];
  if (!orderNumber) {
    console.log('Usage: npx tsx scripts/test-d2-slips.ts FP-2026-XXXX');
    process.exit(1);
  }

  console.log(`\n🧪 D.2 smoke test for order ${orderNumber}\n`);

  // Verify order exists
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);

  if (!order) {
    console.log(`❌ Order ${orderNumber} not found in database`);
    await closeDatabase();
    process.exit(1);
  }

  console.log(`✓ Order found: status=${order.status}, fulfillment=${order.fulfillmentMethod}`);

  // Count existing slip jobs (in case we're re-running)
  const existingSlips = await db
    .select()
    .from(slipJobs)
    .where(eq(slipJobs.orderId, order.id));

  console.log(`  Pre-existing slip jobs for this order: ${existingSlips.length}`);

  // Trigger markOrderPaid
  console.log(`\n→ Calling markOrderPaid('${orderNumber}', 'TEST-D2-SMOKE')...\n`);

  try {
    await markOrderPaid(orderNumber, 'TEST-D2-SMOKE');
  } catch (err) {
    console.log(`❌ markOrderPaid threw an error:`);
    console.error(err);
    await closeDatabase();
    process.exit(1);
  }

  // Wait a tick for any async work
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Verify slips were queued
  const allSlips = await db
    .select()
    .from(slipJobs)
    .where(eq(slipJobs.orderId, order.id))
    .orderBy(desc(slipJobs.queuedAt));

  const newSlips = allSlips.slice(0, allSlips.length - existingSlips.length);

  console.log(`\n📋 Slip jobs queued (${newSlips.length} new):\n`);

  if (newSlips.length === 0) {
    console.log(`❌ No new slip jobs were created. Check server logs for errors.`);
    await closeDatabase();
    process.exit(1);
  }

  for (const slip of newSlips) {
    const summary = slip.printReadyFileUrl
      ? `URL: ${slip.printReadyFileUrl}`
      : slip.payloadJson
        ? `payload (ZPL, ${JSON.stringify(slip.payloadJson).length} chars)`
        : 'NO URL OR PAYLOAD';
    console.log(`  ${slip.slipType.padEnd(18)} target=${slip.targetPrinterType.padEnd(15)} seq=${String(slip.sequencePosition).padEnd(4)} ${summary}`);
  }

  // Sanity checks
  const expectedTypes = ['order_info', 'end_separator', 'envelope_label'];
  const gotTypes = newSlips.map((s) => s.slipType).sort();
  expectedTypes.sort();

  console.log(`\n📊 Result summary:\n`);

  if (JSON.stringify(gotTypes) === JSON.stringify(expectedTypes)) {
    console.log(`  ✅ All 3 expected slip types queued`);
  } else {
    console.log(`  ❌ Wrong slip types. Expected ${JSON.stringify(expectedTypes)}, got ${JSON.stringify(gotTypes)}`);
  }

  const dyeSubSlips = newSlips.filter((s) => s.targetPrinterType.startsWith('dye_sub'));
  const thermalSlips = newSlips.filter((s) => s.targetPrinterType === 'thermal_label');

  if (dyeSubSlips.length === 2 && dyeSubSlips.every((s) => s.printReadyFileUrl)) {
    console.log(`  ✅ Both dye-sub slips have B2 URLs`);
  } else {
    console.log(`  ❌ Dye-sub slips missing URLs (${dyeSubSlips.filter((s) => s.printReadyFileUrl).length}/${dyeSubSlips.length} have URLs)`);
  }

  if (thermalSlips.length === 1 && thermalSlips[0].payloadJson) {
    console.log(`  ✅ Thermal slip has ZPL payload`);
  } else {
    console.log(`  ❌ Thermal slip missing payload`);
  }

  console.log('\n✓ Test complete\n');
  await closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
