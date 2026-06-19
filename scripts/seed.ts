/**
 * Seed initial data into the database.
 *
 * Usage: npm run db:seed
 *
 * Idempotent — won't duplicate if run multiple times.
 * Currently seeds:
 *   - Two printers (DNP DS620A and Epson P5300)
 *   - The store_settings singleton (DNP media mode)
 *   - Zimbabwe public holidays (non-working days for fulfilment date math)
 */

import { db, closeDatabase } from '../src/db/client.js';
import { printers, holidays, storeSettings } from '../src/db/schema.js';
import { logger } from '../src/utils/logger.js';
import { eq } from 'drizzle-orm';

async function seed(): Promise<void> {
  logger.info('Seeding initial data...');

  const seedPrinters = [
    {
      name: 'DNP DS620A',
      printerType: 'dye_sub' as const,
      osPrinterName: 'FPDS620A', // Windows print-queue name on the agent mini-PC
      currentMedia: '6x8 ribbon',
      status: 'offline' as const,
    },
    {
      name: 'Epson SureColor P5300',
      printerType: 'inkjet' as const,
      osPrinterName: 'FP5300', // Windows print-queue name on the agent mini-PC
      currentMedia: '17in luster roll',
      status: 'offline' as const,
    },
  ];

  for (const p of seedPrinters) {
    const existing = await db.select().from(printers).where(eq(printers.name, p.name));
    if (existing.length > 0) {
      logger.info(`Printer "${p.name}" already exists, skipping`);
      continue;
    }
    await db.insert(printers).values(p);
    logger.info(`✅ Seeded printer: ${p.name}`);
  }

  // Store-settings singleton (DNP media mode defaults to '6x8'). Idempotent.
  await db.insert(storeSettings).values({ id: 1 }).onConflictDoNothing();
  logger.info('✅ Ensured store_settings singleton (DNP media mode)');

  // Zimbabwe public holidays — non-working days for fulfilment date math (treated
  // exactly like Sundays). ⚠️ MAINTAIN per year: Easter-based dates move and any
  // presidentially-declared holidays must be added. Observed Mondays are included
  // where a fixed holiday falls on a Sunday (ZW rolls it to the following Monday).
  const seedHolidays: { date: string; name: string }[] = [
    // 2026
    { date: '2026-01-01', name: "New Year's Day" },
    { date: '2026-04-03', name: 'Good Friday' },
    { date: '2026-04-04', name: 'Easter Saturday' },
    { date: '2026-04-06', name: 'Easter Monday' },
    { date: '2026-04-18', name: 'Independence Day' },
    { date: '2026-05-01', name: "Workers' Day" },
    { date: '2026-05-25', name: 'Africa Day' },
    { date: '2026-08-10', name: "Heroes' Day" },
    { date: '2026-08-11', name: 'Defence Forces Day' },
    { date: '2026-12-22', name: 'Unity Day' },
    { date: '2026-12-25', name: 'Christmas Day' },
    { date: '2026-12-26', name: 'Boxing Day' },
    // 2027
    { date: '2027-01-01', name: "New Year's Day" },
    { date: '2027-03-26', name: 'Good Friday' },
    { date: '2027-03-27', name: 'Easter Saturday' },
    { date: '2027-03-29', name: 'Easter Monday' },
    { date: '2027-04-18', name: 'Independence Day' },
    { date: '2027-04-19', name: 'Independence Day (observed)' }, // 18th is a Sunday
    { date: '2027-05-01', name: "Workers' Day" },
    { date: '2027-05-25', name: 'Africa Day' },
    { date: '2027-08-09', name: "Heroes' Day" },
    { date: '2027-08-10', name: 'Defence Forces Day' },
    { date: '2027-12-22', name: 'Unity Day' },
    { date: '2027-12-25', name: 'Christmas Day' },
    { date: '2027-12-26', name: 'Boxing Day' },
    { date: '2027-12-27', name: 'Boxing Day (observed)' }, // 26th is a Sunday
  ];
  await db.insert(holidays).values(seedHolidays).onConflictDoNothing();
  logger.info(`✅ Seeded ${seedHolidays.length} public holidays (idempotent)`);

  logger.info('✅ Seeding complete');
}

seed()
  .catch((err: unknown) => {
    logger.fatal({ err }, '❌ Seed failed');
    process.exit(1);
  })
  .finally(() => {
    void closeDatabase();
  });
