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
