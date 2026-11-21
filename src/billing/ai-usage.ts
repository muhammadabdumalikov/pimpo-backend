// Pure rules of the customer AI bot's pay-as-you-go billing (ONLAYN-SOTUVCHI.md
// §11, AI-YORDAMCHI.md Q11). No I/O: AiUsageService feeds these what it read.
//
// The bot has no price of its own. A plan either carries it or does not
// (tier.ts includesAiBot), and every answer costs what its tokens cost us plus
// SYSTEM_TOKEN_MARKUP — unless the plan still has free answers left.

import {
  defaultModelFor,
  estimateCostUsd,
  type AiProviderId,
} from '../ai/providers/llm-provider.interface';
import {gateTier, tierAtLeast} from '../subscription/tier';
import {
  REMINDER_DAYS,
  asDate,
  computeMonthlyTotal,
  cycleTotal,
  tashkentDaysBetween,
  type BillingCycle,
  type DiscountTerm,
} from './billing';
import {renewsAt} from './branch-billing';

/** Free answers of the online seller plan's signup trial, once. */
export const TRIAL_FREE_ANSWERS = 500;
/** Free answers Business+ gets every calendar month (env-tunable). */
export const PLAN_FREE_ANSWERS = 2_000;
/** So'm per US dollar when the central bank's rate cannot be read. */
export const USD_RATE_FALLBACK = 12_000;

/**
 * A measured answer (AI-YORDAMCHI.md eval: ~3k tokens in, a short reply out),
 * for quoting "about N so'm an answer" before a shop has answers of its own.
 */
export const TYPICAL_ANSWER_TOKENS = {input: 3_000, output: 150};

export interface FreeAllowance {
  /** 'trial' — once, over the trial; 'monthly' — renewed each calendar month. */
  kind: 'trial' | 'monthly';
  limit: number;
}

/** The free answers a subscription carries, if any. */
export function freeAllowance(input: {
  planTier: string | null;
  isTrial: boolean;
  /** Business+'s monthly allowance (AI_ASSISTANT_MONTHLY_LIMIT). */
  monthlyLimit?: number;
}): FreeAllowance | null {
  if (tierAtLeast(gateTier(input.planTier), 'proplus')) {
    return {kind: 'monthly', limit: input.monthlyLimit ?? PLAN_FREE_ANSWERS};
  }
  if (input.planTier === 'online' && input.isTrial) {
    return {kind: 'trial', limit: TRIAL_FREE_ANSWERS};
  }
  return null;
}

const money = (n: number) => Math.round(n * 100) / 100;

/**
 * What one answer costs the shop, in so'm: the tokens at the provider's list
 * price, plus our margin, at `usdRate`. A model missing from the price table
 * is billed as the provider's default one — an unlisted id must not make the
 * bot free.
 */
export function answerCharge(input: {
  provider: AiProviderId;
  model: string;
  tokensIn: number;
  tokensOut: number;
  usdRate: number;
}): number {
  const {provider, tokensIn, tokensOut} = input;
  if (tokensIn <= 0 && tokensOut <= 0) return 0;
  const usd =
    estimateCostUsd(input.model, provider, tokensIn, tokensOut, true) ||
    estimateCostUsd(
      defaultModelFor(provider),
      provider,
      tokensIn,
      tokensOut,
      true,
    );
  return money(usd * input.usdRate);
}

/** "About N so'm an answer" on this model at this rate. */
export function typicalAnswerCharge(
  provider: AiProviderId,
  model: string,
  usdRate: number,
): number {
  return answerCharge({
    provider,
    model,
    tokensIn: TYPICAL_ANSWER_TOKENS.input,
    tokensOut: TYPICAL_ANSWER_TOKENS.output,
    usdRate,
  });
}

/**
 * A month of the coming renewal as tryRenew prices it: the plan it will
 * charge (a scheduled downgrade's when there is one — a discount tied to the
 * current plan does not follow it), the extra stores it will take, the
 * discounts in force. What renewalReserve holds back is built from this, by
 * the bot's gate and by the settlement alike, so the two cannot disagree.
 *
 * The stores are tryRenew's candidates (branch-billing.ts renewsAt): kept
 * renewing and out of their free days when the renewal runs — taken as the
 * end date, or now once that has passed (the renewal is then due at once).
 * A store opened in the last days of the period is still free then, is not
 * charged, and so is not held for.
 */
export function renewalMonthlyTotal(input: {
  plan: {price: string | number; tier: string} | null;
  pendingPlan?: {price: string | number; tier: string} | null;
  /** The active extra (non-default) stores. */
  stores: readonly {renew: boolean; freeUntil: Date | string | null}[];
  endDate: Date | string | null;
  discounts: readonly DiscountTerm[];
  now?: Date;
}): number {
  const plan = input.pendingPlan ?? input.plan;
  if (!plan) return 0;
  const now = input.now ?? new Date();
  const at =
    input.endDate != null && asDate(input.endDate) > now
      ? asDate(input.endDate)
      : now;
  return computeMonthlyTotal({
    planPrice: Number(plan.price),
    planTier: plan.tier,
    extraBranches: input.stores.filter((s) => renewsAt(s, at)).length,
    discounts: input.discounts,
    now,
  }).total;
}

/**
 * The part of the balance the bot must leave alone, from the day the payment
 * reminders start (REMINDER_DAYS before the end) until the renewal has taken
 * it: the next month (renewalMonthlyTotal) — or, when the next renewal is
 * wanted as a year and the balance covers the year, the whole year
 * (cycleTotal, what tryRenew charges), so the bot cannot be what turns a paid
 * year into a month. Short of the year the renewal falls back to a month
 * anyway, so a month is all that is held.
 *
 * "Covers" is measured against the balance as it stands, NOT less the
 * unsettled answers: those may include the last answer's overshoot past what
 * was spendable, and if that debt could tip the reserve back to a month, the
 * settlement would take it out of the year's money. Measured this way, a
 * balance at or above the year stays there — settlements never take it below
 * the reserve.
 *
 * Earlier in the period the next payment is weeks away and the balance is the
 * bot's to use; an open-ended subscription (end_date null) is never billed,
 * so nothing is ever held.
 */
export function renewalReserve(input: {
  endDate: Date | string | null;
  /** renewalMonthlyTotal. */
  monthlyTotal: number;
  /** The cycle the next renewal is wanted for (billing_profiles.billing_cycle). */
  cycleWanted: BillingCycle;
  /** The balance as it stands (see above). */
  balance: number;
  now?: Date;
}): number {
  if (input.endDate == null) return 0;
  const daysLeft = tashkentDaysBetween(input.now ?? new Date(), input.endDate);
  if (daysLeft > REMINDER_DAYS) return 0;
  const month = Math.max(0, input.monthlyTotal);
  if (input.cycleWanted === 'year') {
    const year = cycleTotal(month, 'year');
    if (input.balance >= year) return year;
  }
  return month;
}

/**
 * What the bot may still spend: the balance less the answers not yet taken
 * from it and less `reserve` (renewalReserve). The bot never eats the money
 * the coming renewal needs, so it cannot be what closes the shop.
 */
export function spendable(input: {
  balance: number;
  unsettled: number;
  reserve: number;
}): number {
  return Math.max(0, money(input.balance - input.unsettled - input.reserve));
}

/** How the next answer is paid for. */
export type BotFunds = 'free' | 'paid' | 'blocked';

export function botFunds(input: {
  free: {limit: number; used: number} | null;
  balance: number;
  unsettled: number;
  reserve: number;
}): BotFunds {
  if (input.free && input.free.used < input.free.limit) return 'free';
  return spendable(input) > 0 ? 'paid' : 'blocked';
}

/**
 * What a settlement takes from the balance: whole so'm only (the fraction
 * waits for the next one), and never more than the balance holds above
 * `reserve` (renewalReserve) — what is left stays owed and keeps the bot off
 * until it is covered. The reserve matters because botFunds lets the last
 * answer cost more than was spendable (an answer's price is known only after
 * it ran): taking that overshoot out of the coming renewal's money would let
 * one answer leave the renewal short and the shop locked.
 */
export function settlement(input: {
  unsettled: number;
  answers: number;
  balance: number;
  reserve?: number;
}): {amount: number; answers: number} {
  const due = Math.floor(input.unsettled);
  const available = Math.floor(input.balance - (input.reserve ?? 0));
  const amount = Math.max(0, Math.min(due, available));
  if (amount <= 0) return {amount: 0, answers: 0};
  const answers =
    amount >= due ? input.answers : Math.floor((input.answers * amount) / due);
  return {amount, answers};
}
