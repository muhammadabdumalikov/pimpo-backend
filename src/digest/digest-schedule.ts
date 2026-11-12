// When the daily digest goes out and which hours it covers. Pure functions over
// business-zone wall-clock 'HH:MM' strings — Asia/Tashkent is a fixed +05:00
// (see common/business-time.ts), so plain millisecond arithmetic is exact.

const ZONE_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

/** 'HH:MM', 00:00–23:59. */
export const HM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A send slot is still delivered this long after it passed (restart, deploy). */
export const CATCH_UP_MS = 2 * 3_600_000;

export const DIGEST_DEFAULTS = {
  sendAt: '21:00',
  from: '00:00',
  to: '21:00',
} as const;

function minutesOf(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** The latest instant at or before `ref` whose business-zone clock reads `hm`. */
export function latestOccurrence(ref: Date, hm: string): Date {
  const local = ref.getTime() + ZONE_MS;
  let at = Math.floor(local / DAY_MS) * DAY_MS + minutesOf(hm) * 60_000;
  if (at > local) at -= DAY_MS;
  return new Date(at - ZONE_MS);
}

/**
 * The window a digest sent at `slot` reports on. `from` ≥ `to` crosses midnight
 * (22:00–03:00); `from` = `to` is a full 24 hours. End is exclusive.
 *  - slot inside a window (09:00–23:00 sent at 21:00): that window so far,
 *    [from, slot) — today's 09:00–21:00, not yesterday's;
 *  - otherwise: the latest [from, to) that closed by the slot. A full 24 h
 *    is always "otherwise" — every slot is inside one, and the owner who
 *    picked a whole day wants the last whole day.
 */
export function digestWindow(
  slot: Date,
  from: string,
  to: string,
): {start: Date; end: Date} {
  const spanMs =
    ((minutesOf(to) - minutesOf(from) + 24 * 60) % (24 * 60) || 24 * 60) * 60_000;
  const closed = latestOccurrence(slot, to);
  if (spanMs < DAY_MS && closed.getTime() < slot.getTime()) {
    const openStart = closed.getTime() + DAY_MS - spanMs;
    if (openStart <= slot.getTime()) {
      return {start: new Date(openStart), end: slot};
    }
  }
  return {start: new Date(closed.getTime() - spanMs), end: closed};
}

/**
 * The send slot due at `now`, or null: the latest `sendAt` that passed within
 * the catch-up window and was not handled yet.
 */
export function dueSlot(
  now: Date,
  sendAt: string,
  lastSentAt: Date | null,
): Date | null {
  const slot = latestOccurrence(now, sendAt);
  if (now.getTime() - slot.getTime() > CATCH_UP_MS) return null;
  if (lastSentAt && lastSentAt.getTime() >= slot.getTime()) return null;
  return slot;
}

/** Business-zone 'YYYY-MM-DD' and 'HH:MM' of an instant. */
export function localParts(d: Date): {ymd: string; hm: string} {
  const iso = new Date(d.getTime() + ZONE_MS).toISOString();
  return {ymd: iso.slice(0, 10), hm: iso.slice(11, 16)};
}
