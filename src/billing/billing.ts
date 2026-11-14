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

// Monthly price of the AI bot add-on on the online seller plan
// (ONLAYN-SOTUVCHI.md Q10, E5): 1 000 answers a month.
export const AI_ADDON_PRICE = 149_000;
export const AI_ADDON_MONTHLY_ANSWERS = 1_000;

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

/**
 * What a discount is (subscription_discounts.kind):
 * - percent: `percent` % off whatever `scope` names;
 * - amount:  `amount` so'm off the month's total;
 * - price:   `amount` so'm replaces the list price — of the plan (scope
 *            'plan'), or of each extra branch (scope 'branches'). It can only
 *            lower a price, never raise it.
 */
export type DiscountKind = 'percent' | 'amount' | 'price';
/** What a percent comes off, or which list price a `price` replaces. */
export type DiscountScope = 'plan' | 'branches' | 'all';

export const DISCOUNT_KINDS: readonly DiscountKind[] = [
  'percent',
  'amount',
  'price',
];
export const DISCOUNT_SCOPES: readonly DiscountScope[] = [
  'plan',
  'branches',
  'all',
];

/**
 * One discount as the rules read it. `kind` and `scope` are optional because
 * rows cached before they existed carry neither: such a row is a percent off
 * the plan, which is all a discount could be then.
 */
export interface DiscountTerm {
  id?: string | null;
  label?: string | null;
  /** DiscountKind; a plain string because that is what the column gives. */
  kind?: string | null;
  /** DiscountScope, likewise. */
  scope?: string | null;
  percent: number;
  amount?: number | null;
  /** When set, the discount holds only while the shop is on this plan. */
  planTier?: string | null;
  validUntil: Date | string | null;
}

/** What one discount took off the month, for the breakdown. */
export interface DiscountLine {
  id: string | null;
  label: string | null;
  kind: DiscountKind;
  amount: number;
}

export interface MonthlyTotal {
  /** List price of the plan. */
  planPrice: number;
  extraBranches: number;
  /** List price of the extra branches. */
  extraBranchesTotal: number;
  /** The AI bot add-on (0 when not taken). No plan discount reaches it. */
  aiAddon: number;
  /** List price of the month, before any discount. */
  subtotal: number;
  /** The percent off the plan alone (0–100) — what older readers show. */
  discountPercent: number;
  /** Everything the discounts took off: subtotal − total. */
  discountAmount: number;
  /** discountAmount split by discount, in the order they were applied. */
  discountLines: DiscountLine[];
  total: number;
}

/** The step of computeMonthlyTotal each kind is applied in. */
const APPLY_ORDER: Record<DiscountKind, number> = {
  price: 0,
  percent: 1,
  amount: 2,
};

const kindOf = (d: DiscountTerm): DiscountKind =>
  d.kind === 'amount' || d.kind === 'price' ? d.kind : 'percent';
const scopeOf = (d: DiscountTerm): DiscountScope =>
  d.scope === 'branches' || d.scope === 'all' ? d.scope : 'plan';

/** The discounts that hold at `now` for a shop on `planTier`. */
export function discountsInForce<T extends DiscountTerm>(
  discounts: readonly T[],
  planTier: string | null,
  now: Date = new Date(),
): T[] {
  return discounts.filter(
    (d) =>
      (d.validUntil == null ||
        asDate(d.validUntil).getTime() > now.getTime()) &&
      (d.planTier == null || d.planTier === planTier),
  );
}

/** Split `total` between percent discounts by their share; the last takes the rounding. */
function sharePercentOff(
  total: number,
  terms: DiscountTerm[],
  add: (d: DiscountTerm, amount: number) => void,
) {
  const sum = terms.reduce((s, d) => s + Math.max(0, d.percent), 0);
  if (total <= 0 || sum <= 0) return;
  let left = total;
  terms.forEach((d, i) => {
    const part =
      i === terms.length - 1
        ? left
        : Math.min(left, Math.round((total * Math.max(0, d.percent)) / sum));
    left -= part;
    add(d, part);
  });
}

/**
 * What a month costs (§2 "Oylik summa"): plan + extra branches × 150 000
 * (+ the AI add-on), less the discounts in force. One fixed order, whatever
 * order they were granted in:
 *   1. a `price` replaces the list price of the plan / of each extra branch
 *      (the lowest one wins when there are several);
 *   2. the percents of a scope add up (capped at 100) and come off that price;
 *   3. the `amount`s come off what is left, never below zero.
 * The add-on is never re-priced or taken a percent off (ONLAYN-SOTUVCHI.md
 * E5); only a fixed `amount` can eat into it, as part of the whole month.
 */
export function computeMonthlyTotal(input: {
  planPrice: number;
  /** The plan being priced — discounts tied to another plan do not apply. */
  planTier: string | null;
  extraBranches: number;
  /** The AI bot add-on is billed this month. */
  aiAddon?: boolean;
  discounts?: readonly DiscountTerm[];
  now?: Date;
}): MonthlyTotal {
  const planPrice = Math.max(0, input.planPrice);
  const extraBranches = Math.max(0, input.extraBranches);
  const extraBranchesTotal = extraBranches * EXTRA_BRANCH_PRICE;
  const aiAddon = input.aiAddon ? AI_ADDON_PRICE : 0;
  const subtotal = planPrice + extraBranchesTotal + aiAddon;
  const live = discountsInForce(
    input.discounts ?? [],
    input.planTier,
    input.now,
  );

  const taken = new Map<DiscountTerm, number>();
  const add = (d: DiscountTerm, amount: number) => {
    if (amount > 0) taken.set(d, (taken.get(d) ?? 0) + amount);
  };
  const lowestPrice = (scope: DiscountScope) =>
    live
      .filter(
        (d) => kindOf(d) === 'price' && scopeOf(d) === scope && d.amount != null,
      )
      .sort((a, b) => Number(a.amount) - Number(b.amount))[0];

  // 1. Price overrides.
  let planBase = planPrice;
  const planLock = lowestPrice('plan');
  if (planLock && Number(planLock.amount) < planPrice) {
    planBase = Math.max(0, Number(planLock.amount));
    add(planLock, planPrice - planBase);
  }
  let branchUnit = EXTRA_BRANCH_PRICE;
  const branchLock = lowestPrice('branches');
  if (branchLock && Number(branchLock.amount) < EXTRA_BRANCH_PRICE) {
    branchUnit = Math.max(0, Number(branchLock.amount));
    add(branchLock, extraBranches * (EXTRA_BRANCH_PRICE - branchUnit));
  }
  const branchBase = extraBranches * branchUnit;

  // 2. Percents, per scope.
  const percents = live.filter((d) => kindOf(d) === 'percent');
  const onPlan = percents.filter((d) => scopeOf(d) !== 'branches');
  const onBranches = percents.filter((d) => scopeOf(d) !== 'plan');
  const capped = (terms: DiscountTerm[]) =>
    Math.min(
      100,
      terms.reduce((s, d) => s + Math.max(0, d.percent), 0),
    );
  const planPercent = capped(onPlan);
  const planOff = Math.round((planBase * planPercent) / 100);
  const branchOff = Math.round((branchBase * capped(onBranches)) / 100);
  sharePercentOff(planOff, onPlan, add);
  sharePercentOff(branchOff, onBranches, add);

  // 3. Fixed sums off what is left.
  let total = planBase - planOff + branchBase - branchOff + aiAddon;
  for (const d of live) {
    if (kindOf(d) !== 'amount') continue;
    const part = Math.min(total, Math.max(0, Number(d.amount ?? 0)));
    total -= part;
    add(d, part);
  }

  return {
    planPrice,
    extraBranches,
    extraBranchesTotal,
    aiAddon,
    subtotal,
    discountPercent: planPercent,
    discountAmount: subtotal - total,
    // In the order they were applied (price, percent, amount), so the lines
    // read top to bottom as the sum was worked out — a percent's amount only
    // makes sense after the special price it was taken from.
    discountLines: live
      .filter((d) => taken.has(d))
      .sort((a, b) => APPLY_ORDER[kindOf(a)] - APPLY_ORDER[kindOf(b)])
      .map((d) => ({
        id: d.id ?? null,
        label: d.label ?? null,
        kind: kindOf(d),
        amount: taken.get(d)!,
      })),
    total,
  };
}

/** A discount as the platform console asks for it. */
export interface DiscountInput {
  kind?: string;
  scope?: string;
  percent?: number;
  amount?: number;
  planTier?: string;
  validUntil?: string;
}

/** The columns a valid request fills (label and ids aside). */
export interface NormalizedDiscount {
  kind: DiscountKind;
  scope: DiscountScope;
  percent: number;
  amount: number | null;
  planTier: string | null;
  validUntil: Date | null;
}

const isInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n);

/**
 * Turn a request into a row, or name the field that is wrong.
 * - percent: 1–100 off the plan (default), the branches, or both;
 * - amount:  so'm off the whole month — the scope is not asked;
 * - price:   so'm instead of the plan's list price or of each branch's; on
 *            the plan it is tied to a plan tier (`currentPlanTier` unless the
 *            request names one), so it does not follow the shop to another.
 */
export function normalizeDiscountInput(
  input: DiscountInput,
  currentPlanTier: string | null,
): NormalizedDiscount | {error: string} {
  const kind = input.kind ?? 'percent';
  if (!DISCOUNT_KINDS.includes(kind as DiscountKind)) return {error: 'kind'};
  if (
    input.scope != null &&
    !DISCOUNT_SCOPES.includes(input.scope as DiscountScope)
  ) {
    return {error: 'scope'};
  }
  let validUntil: Date | null = null;
  if (input.validUntil) {
    validUntil = new Date(input.validUntil);
    if (Number.isNaN(validUntil.getTime())) return {error: 'validUntil'};
  }
  const planTier = input.planTier || null;

  if (kind === 'percent') {
    if (!isInt(input.percent) || input.percent < 1 || input.percent > 100) {
      return {error: 'percent'};
    }
    return {
      kind,
      scope: (input.scope as DiscountScope) ?? 'plan',
      percent: input.percent,
      amount: null,
      planTier,
      validUntil,
    };
  }

  if (kind === 'amount') {
    if (!isInt(input.amount) || input.amount < 1) return {error: 'amount'};
    return {
      kind,
      scope: 'all',
      percent: 0,
      amount: input.amount,
      planTier,
      validUntil,
    };
  }

  // price
  if (!isInt(input.amount) || input.amount < 0) return {error: 'amount'};
  const scope = (input.scope as DiscountScope) ?? 'plan';
  if (scope === 'all') return {error: 'scope'};
  const tier = scope === 'plan' ? (planTier ?? currentPlanTier) : planTier;
  if (scope === 'plan' && !tier) return {error: 'planTier'};
  return {
    kind: 'price',
    scope,
    percent: 0,
    amount: input.amount,
    planTier: tier,
    validUntil,
  };
}

/** Nearest 1 000 so'm. */
export function round1000(amount: number): number {
  return Math.round(amount / 1000) * 1000;
}

/**
 * What the rest of the period costs: `monthlyAmount` × remaining / period
 * days, to the nearest 1 000 (§5). Never negative; the remaining days are
 * capped at the period length. Callers pass the amount already net of
 * discounts (the difference of two computeMonthlyTotal totals); the percent
 * here is only for an amount that is not.
 */
export function prorate(input: {
  monthlyAmount: number;
  discountPercent?: number;
  daysRemaining: number;
  periodDays: number;
}): number {
  const periodDays = Math.max(1, input.periodDays);
  const days = Math.min(periodDays, Math.max(0, input.daysRemaining));
  const discounted =
    input.monthlyAmount * (1 - (input.discountPercent ?? 0) / 100);
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
