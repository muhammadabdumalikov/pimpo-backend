// Business timezone helpers.
//
// The business operates in Asia/Tashkent — a FIXED +05:00 offset (Uzbekistan has
// observed no DST since 1992, so a constant offset is exact and DST-proof).
//
// Date-only filter strings ("YYYY-MM-DD") coming from the UI denote calendar days
// in THIS zone (the user's local day — the same day the UI labels a sale under).
// The naive `new Date("2026-07-20")` parses the string as UTC midnight, which is
// 05:00 into the local day; filtering on that drops sales rung between local 00:00
// and 05:00 (they land in the previous UTC day). That is the bug where "today"
// hid early-morning sales that "this month" still listed. Convert the day to the
// exact UTC instants that bound it in the business zone instead.

export const BUSINESS_UTC_OFFSET = '+05:00';

/** Start instant (00:00:00.000, business zone) of the calendar day `ymd`. */
export function businessDayStart(ymd: string): Date {
  return new Date(`${ymd.slice(0, 10)}T00:00:00.000${BUSINESS_UTC_OFFSET}`);
}

/** End instant (23:59:59.999, business zone) of the calendar day `ymd`. */
export function businessDayEnd(ymd: string): Date {
  return new Date(`${ymd.slice(0, 10)}T23:59:59.999${BUSINESS_UTC_OFFSET}`);
}

/** The +05:00 offset in milliseconds — the same shift, for Date arithmetic. */
export const BUSINESS_OFFSET_MS = 5 * 3_600_000;

/** Current calendar month ("YYYY-MM") in the business zone. */
export function businessMonth(now: Date = new Date()): string {
  const local = new Date(now.getTime() + BUSINESS_OFFSET_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The last `count` calendar months in the business zone, oldest first and
 * ending with the current one: ['2026-04' … '2026-09'] for count = 6. Crosses
 * the year boundary, unlike a calendar-year window.
 */
export function recentBusinessMonths(
  count: number,
  now: Date = new Date(),
): string[] {
  const [y, m] = businessMonth(now).split('-').map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
    );
  }
  return out;
}

/** Current calendar day ("YYYY-MM-DD") in the business zone. */
export function businessDay(now: Date = new Date()): string {
  return new Date(now.getTime() + BUSINESS_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** Bucket width of a time series: one point per hour, day or month. */
export type BucketUnit = 'hour' | 'day' | 'month';

/**
 * Every bucket label between the calendar days `from` and `to` (both inclusive,
 * business zone), oldest first — the x-axis of a time series, including the
 * buckets with no rows, which a GROUP BY can never return.
 *
 * Labels match what `to_char(date_trunc(unit, created_at + interval '5 hours'))`
 * emits for the same unit, so a query result keys straight into this list:
 * hour → '2026-09-13 14', day → '2026-09-13', month → '2026-09'.
 */
export function businessBuckets(
  unit: BucketUnit,
  from: string,
  to: string,
): string[] {
  // Work on UTC instants shifted into the business zone, so getUTC* reads the
  // local calendar and the loop is plain arithmetic with no DST to consider.
  const startMs = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`);
  const endMs = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }
  const out: string[] = [];

  if (unit === 'month') {
    const s = new Date(startMs);
    const e = new Date(endMs);
    let y = s.getUTCFullYear();
    let m = s.getUTCMonth();
    while (y < e.getUTCFullYear() || (y === e.getUTCFullYear() && m <= e.getUTCMonth())) {
      out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
      if (++m > 11) {
        m = 0;
        y++;
      }
    }
    return out;
  }

  const step = unit === 'hour' ? 3_600_000 : 86_400_000;
  // `to` is a whole day: run to its last hour, not its first.
  const last = unit === 'hour' ? endMs + 23 * 3_600_000 : endMs;
  for (let t = startMs; t <= last; t += step) {
    const iso = new Date(t).toISOString();
    out.push(unit === 'hour' ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}` : iso.slice(0, 10));
  }
  return out;
}
