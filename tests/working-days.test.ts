/**
 * working-days — next-working-day math for 5×7 fulfilment dates.
 *
 * Reference calendar dates (CAT):
 *   2026-06-19 = Friday, 2026-06-20 = Saturday, 2026-06-21 = Sunday,
 *   2026-06-22 = Monday.
 *   Dec 2026 holidays seeded: 25 (Fri, Christmas), 26 (Sat, Boxing); 27 = Sunday.
 */

import { describe, it, expect } from 'vitest';
import { isWorkingDay, nextWorkingDay, catDateString } from '@/utils/working-days.js';

// An instant at noon CAT (10:00 UTC) of the given CAT date.
const at = (isoDate: string) => new Date(`${isoDate}T10:00:00.000Z`);
const NO_HOLIDAYS = new Set<string>();

describe('catDateString (CAT boundary)', () => {
  it('shifts late-UTC instants into the next CAT day', () => {
    // 2026-06-20 22:30 UTC == 2026-06-21 00:30 CAT
    expect(catDateString(new Date('2026-06-20T22:30:00.000Z'))).toBe('2026-06-21');
  });
});

describe('isWorkingDay', () => {
  it('Sunday is not a working day', () => {
    expect(isWorkingDay(at('2026-06-21'), NO_HOLIDAYS)).toBe(false); // Sunday
  });
  it('Saturday IS a working day', () => {
    expect(isWorkingDay(at('2026-06-20'), NO_HOLIDAYS)).toBe(true); // Saturday
  });
  it('a holiday is not a working day', () => {
    expect(isWorkingDay(at('2026-06-22'), new Set(['2026-06-22']))).toBe(false); // Mon holiday
  });
});

describe('nextWorkingDay', () => {
  it('weekday → next day', () => {
    expect(catDateString(nextWorkingDay(at('2026-06-22'), NO_HOLIDAYS))).toBe('2026-06-23'); // Mon → Tue
  });
  it('Friday → Saturday (Saturday is a working day)', () => {
    expect(catDateString(nextWorkingDay(at('2026-06-19'), NO_HOLIDAYS))).toBe('2026-06-20'); // Fri → Sat
  });
  it('Saturday → Monday (skips Sunday)', () => {
    expect(catDateString(nextWorkingDay(at('2026-06-20'), NO_HOLIDAYS))).toBe('2026-06-22'); // Sat → Mon
  });
  it('rolls over consecutive holidays + Sunday', () => {
    // From Thu Dec 24: Fri 25 (Christmas) + Sat 26 (Boxing) + Sun 27 all skipped → Mon 28
    const holidays = new Set(['2026-12-25', '2026-12-26']);
    expect(catDateString(nextWorkingDay(at('2026-12-24'), holidays))).toBe('2026-12-28');
  });
  it('is computed in CAT — a late-Saturday-night CAT order still rolls to Monday', () => {
    // 2026-06-20 21:30 UTC == 2026-06-20 23:30 CAT (still Saturday in CAT)
    const lateSat = new Date('2026-06-20T21:30:00.000Z');
    expect(catDateString(nextWorkingDay(lateSat, NO_HOLIDAYS))).toBe('2026-06-22');
  });
});
