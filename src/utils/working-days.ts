/**
 * Working-day / fulfilment-date math.
 *
 * Used to compute the "next working day" availability date for orders that
 * contain a 5×7 print (operator-gated — see services/order.ts
 * applyFiveBySevenHandling and the spec in memory five-by-seven-handling.md).
 *
 * Rules (locked):
 *   - Working days are Mon–Sat. **Sundays are NOT working days.**
 *   - Public holidays are NOT working days (treated exactly like Sundays).
 *   - All day boundaries are evaluated in **Africa/Harare (CAT, UTC+2, no DST)**,
 *     so "ordered Saturday → ready Monday" is correct regardless of server TZ.
 *
 * The functions are pure: the caller loads holiday dates from the `holidays`
 * table and passes them in as a Set of ISO 'YYYY-MM-DD' strings (CAT).
 */

// CAT is a fixed UTC+2 offset year-round (Zimbabwe observes no daylight saving).
const CAT_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar date in CAT for an instant, as ISO 'YYYY-MM-DD'. */
export function catDateString(instant: Date): string {
  return new Date(instant.getTime() + CAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Day of week in CAT (0 = Sunday … 6 = Saturday). */
function catDayOfWeek(instant: Date): number {
  return new Date(instant.getTime() + CAT_OFFSET_MS).getUTCDay();
}

/** True if the instant's CAT date is a working day (not Sunday, not a holiday). */
export function isWorkingDay(instant: Date, holidays: ReadonlySet<string>): boolean {
  return catDayOfWeek(instant) !== 0 && !holidays.has(catDateString(instant));
}

/**
 * The next working day STRICTLY AFTER `from` (evaluated in CAT), rolling over
 * any number of consecutive Sundays/holidays.
 *
 * Returns an instant at **noon CAT** (10:00 UTC) of the resulting day, so the
 * calendar date renders correctly whether formatted in CAT or UTC.
 *
 * Examples (with no holidays): Fri → Sat, Sat → Mon, weekday → next day.
 */
export function nextWorkingDay(from: Date, holidays: ReadonlySet<string>): Date {
  // Anchor at noon CAT of `from`'s CAT date (noon CAT == 10:00 UTC), then step
  // forward whole days until we land on a working day.
  let cursor = new Date(`${catDateString(from)}T10:00:00.000Z`);
  do {
    cursor = new Date(cursor.getTime() + DAY_MS);
  } while (!isWorkingDay(cursor, holidays));
  return cursor;
}
