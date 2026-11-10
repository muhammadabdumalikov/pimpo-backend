import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {
  WEEK_DAYS,
  type BranchWorkingHours,
  type WeekDay,
} from '../database/schema';

/** Shops live on Tashkent time (no DST). */
export const SHOP_TIME_ZONE = 'Asia/Tashkent';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates and normalises a weekly schedule from the API. `null` clears it.
 * Each day is `{open, close}` ("HH:MM") or null/absent = closed. Unknown keys
 * are rejected so a typo ("thur") cannot silently mean "closed".
 */
export function normalizeWorkingHours(
  input: unknown,
): BranchWorkingHours | null {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, {field: 'workingHours'});
  }
  const out: BranchWorkingHours = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(WEEK_DAYS as readonly string[]).includes(key)) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {field: 'workingHours'});
    }
    const day = key as WeekDay;
    if (value === null || value === undefined) {
      out[day] = null;
      continue;
    }
    const v = value as {open?: unknown; close?: unknown};
    if (
      typeof v.open !== 'string' ||
      typeof v.close !== 'string' ||
      !HHMM.test(v.open) ||
      !HHMM.test(v.close) ||
      v.open === v.close
    ) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {field: 'workingHours'});
    }
    out[day] = {open: v.open, close: v.close};
  }
  return out;
}

/** Day + "HH:MM" of `at` on shop time. */
function shopClock(at: Date): {day: WeekDay; time: string; prev: WeekDay} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday').toLowerCase().slice(0, 3) as WeekDay;
  const idx = WEEK_DAYS.indexOf(day);
  const prev = WEEK_DAYS[(idx + 6) % 7];
  return {day, time: `${get('hour')}:${get('minute')}`, prev};
}

/**
 * Is the branch open at `at`? `null` when hours are not set (unknown). A day
 * whose `close` is before `open` runs past midnight into the next day.
 */
export function isOpenAt(
  hours: BranchWorkingHours | null | undefined,
  at: Date = new Date(),
): boolean | null {
  if (!hours) return null;
  const {day, time, prev} = shopClock(at);
  const today = hours[day];
  if (today) {
    if (today.open < today.close) {
      if (time >= today.open && time < today.close) return true;
    } else if (time >= today.open) {
      return true;
    }
  }
  const yesterday = hours[prev];
  if (yesterday && yesterday.close < yesterday.open && time < yesterday.close) {
    return true;
  }
  return false;
}
