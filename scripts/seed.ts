/**
 * Seed initial data into the database.
 *
 * Usage: npm run db:seed
 *
 * Idempotent — won't duplicate if run multiple times.
 * Currently seeds:
 *   - Two printers (DNP DS620A and Epson P5300)
 */

import { db, closeDatabase } from '../src/db/client.js';
import { printers } from '../src/db/schema.js';
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
