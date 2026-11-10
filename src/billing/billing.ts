// Pure billing rules (OBUNA-TOLOV.md §2, §4, §5). No I/O here: BillingService
// feeds these the rows it read, so the rules themselves are unit-tested.

import {BUSINESS_OFFSET_MS, businessDay} from '../common/business-time';

export type BillingStage =
  | 'none'
  | 'reminder'
  | 'urgent'
  | 'grace'
  | 'restricted';

/** Days after end_date during which everything keeps working (Q3). */
export const GRACE_DAYS = 3;
/** The banner starts this many days before end_date (Q2)… */
export const REMINDER_DAYS = 7;
/** …and turns red from this many. */
export const URGENT_DAYS = 3;

// Monthly price of each branch beyond the first (base) one. Mirrors the
// "+150 000" extra-location line in the plan comparison table.
export const EXTRA_BRANCH_PRICE = 150_000;

const DAY_MS = 86_400_000;

/**
 * Dates read back from the Redis cache are ISO strings (JSON round-trip), live
 * Drizzle rows carry Date objects — normalise both.
 */
export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The moment the grace period ends and the plan falls to the free floor. */
export function graceEndsAt(endDate: Date | string): Date {
  return new Date(asDate(endDate).getTime() + GRACE_DAYS * DAY_MS);
}

/** True once the grace period is over (tier gating drops to `free`). */
export function isRestricted(
  endDate: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (endDate == null) return false;
  return now.getTime() >= graceEndsAt(endDate).getTime();
}

/** True once end_date has passed (grace or restricted). */
export function isPastEnd(
  endDate: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (endDate == null) return false;
  return now.getTime() >= asDate(endDate).getTime();
}

/**
 * Asia/Tashkent calendar days from `from` to `to`: 0 when both fall on the
 * same local day, 1 for "tomorrow", negative when `to` is earlier.
 */
export function tashkentDaysBetween(
  from: Date | string,
  to: Date | string,
): number {
  const a = Date.parse(`${businessDay(asDate(from))}T00:00:00Z`);
  const b = Date.parse(`${businessDay(asDate(to))}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

/**
 * The stage the banner, the notices and the platform list show. `amountNeeded`
 * is what the next renewal will charge; a balance covering it means nothing to
 * warn about. Restricted wins over the balance: the plan is already off.
 */
export function computeBillingStage(input: {
  endDate: Date | string | null;
  balance: number;
  amountNeeded: number;
  now?: Date;
}): BillingStage {
  const now = input.now ?? new Date();
  if (input.endDate == null) return 'none';
  if (isRestricted(input.endDate, now)) return 'restricted';
  if (input.balance >= input.amountNeeded) return 'none';
  if (isPastEnd(input.endDate, now)) return 'grace';
  const daysLeft = tashkentDaysBetween(now, input.endDate);
  if (daysLeft > REMINDER_DAYS) return 'none';
  return daysLeft <= URGENT_DAYS ? 'urgent' : 'reminder';
}

/** Sum of the discounts in force at `now`, capped at 100. */
export function totalDiscountPercent(
  discounts: {percent: number; validUntil: Date | string | null}[],
  now: Date = new Date(),
): number {
  const sum = discounts
    .filter(
      (d) =>
        d.validUntil == null || asDate(d.validUntil).getTime() > now.getTime(),
    )
    .reduce((s, d) => s + d.percent, 0);
  return Math.min(100, Math.max(0, sum));
}

export interface MonthlyTotal {
  planPrice: number;
  extraBranches: number;
  extraBranchesTotal: number;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  total: number;
}

/** Plan + extra branches × 150 000 − discount % (§2 "Oylik summa"). */
export function computeMonthlyTotal(input: {
  planPrice: number;
  extraBranches: number;
  discountPercent: number;
}): MonthlyTotal {
  const extraBranches = Math.max(0, input.extraBranches);
  const extraBranchesTotal = extraBranches * EXTRA_BRANCH_PRICE;
  const subtotal = input.planPrice + extraBranchesTotal;
  const discountAmount = Math.round((subtotal * input.discountPercent) / 100);
  return {
    planPrice: input.planPrice,
    extraBranches,
    extraBranchesTotal,
    subtotal,
    discountPercent: input.discountPercent,
    discountAmount,
    total: subtotal - discountAmount,
  };
}

/** Nearest 1 000 so'm. */
export function round1000(amount: number): number {
  return Math.round(amount / 1000) * 1000;
}

/**
 * What the rest of the period costs: `monthlyAmount` (before discount) ×
 * remaining / period days, discounted, to the nearest 1 000 (§5). Never
 * negative; the remaining days are capped at the period length.
 */
export function prorate(input: {
  monthlyAmount: number;
  discountPercent: number;
  daysRemaining: number;
  periodDays: number;
}): number {
  const periodDays = Math.max(1, input.periodDays);
  const days = Math.min(periodDays, Math.max(0, input.daysRemaining));
  const discounted = input.monthlyAmount * (1 - input.discountPercent / 100);
  return Math.max(0, round1000((discounted * days) / periodDays));
}

/** The days a dated period has left and its length, for prorate(). */
export function periodDays(
  startDate: Date | string,
  endDate: Date | string,
  now: Date = new Date(),
): {daysRemaining: number; periodDays: number} {
  const total = Math.max(1, tashkentDaysBetween(startDate, endDate));
  const remaining = Math.min(
    total,
    Math.max(0, tashkentDaysBetween(now, endDate)),
  );
  return {daysRemaining: remaining, periodDays: total};
}

/**
 * The same instant one calendar month later on the Tashkent wall clock, with
 * the day clamped to the target month's length (31 Jan → 28/29 Feb).
 */
export function addCalendarMonth(date: Date | string): Date {
  const local = new Date(asDate(date).getTime() + BUSINESS_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(local.getUTCDate(), lastDay);
  const shifted = Date.UTC(
    y,
    m,
    day,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(shifted - BUSINESS_OFFSET_MS);
}

/**
 * The period a renewal opens (Q11): paid within grace → it continues from the
 * old end date, so the days already used are not free; paid after the plan was
 * restricted → it starts now.
 */
export function nextPeriod(
  oldEndDate: Date | string,
  now: Date = new Date(),
): {start: Date; end: Date} {
  const start = isRestricted(oldEndDate, now) ? now : asDate(oldEndDate);
  return {start, end: addCalendarMonth(start)};
}

/**
 * Which row of the §5 table a self-serve plan change falls in:
 * - fresh:     no subscription, or the open-ended free floor → a dated row is
 *              created already past its grace, then renewed from the balance
 * - managed:   open-ended paid plan from the platform admin → refused
 * - expired:   past end_date (grace or restricted) → swapped free, then renewed
 * - trial:     free and immediate, end_date kept
 * - same:      the current plan again → cancels a scheduled downgrade
 * - upgrade:   not cheaper → immediate, the difference charged pro rata
 * - downgrade: cheaper → scheduled for the next renewal
 */
export type PlanChangeCase =
  | 'fresh'
  | 'managed'
  | 'expired'
  | 'trial'
  | 'same'
  | 'upgrade'
  | 'downgrade';

export function classifyPlanChange(input: {
  current: {
    planTier: string;
    planPrice: number;
    endDate: Date | string | null;
    isTrial: boolean;
  } | null;
  target: {tier: string; price: number};
  now?: Date;
}): {kind: PlanChangeCase; direction: 'upgrade' | 'downgrade' | 'same'} {
  const {current, target} = input;
  const now = input.now ?? new Date();
  const direction: 'upgrade' | 'downgrade' | 'same' = !current
    ? 'upgrade'
    : current.planTier === target.tier
      ? 'same'
      : target.price < current.planPrice
        ? 'downgrade'
        : 'upgrade';

  if (!current) return {kind: 'fresh', direction};
  if (current.endDate == null) {
    return {kind: current.planTier === 'free' ? 'fresh' : 'managed', direction};
  }
  if (isPastEnd(current.endDate, now)) return {kind: 'expired', direction};
  if (current.isTrial) return {kind: 'trial', direction};
  return {kind: direction, direction};
}

/** Hour of day (0–23) on the Tashkent clock. */
export function tashkentHour(now: Date = new Date()): number {
  return new Date(now.getTime() + BUSINESS_OFFSET_MS).getUTCHours();
}
