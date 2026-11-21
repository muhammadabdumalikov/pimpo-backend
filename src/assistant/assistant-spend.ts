// What the customer AI bot cost us against what the shops paid for it, for
// the platform console (ONLAYN-SOTUVCHI.md §11). Pure: AssistantSpendService
// aggregates customer_chat_messages in SQL and hands the grouped rows here.

import {
  AI_PROVIDER_IDS,
  PROVIDER_MODELS,
  SYSTEM_TOKEN_MARKUP,
  defaultModelFor,
  estimateCostUsd,
  type AiProviderId,
} from '../ai/providers/llm-provider.interface';

/** GET /platform/businesses/:id/ai-assistant/spend */
export interface PlatformAiBotSpend {
  /** Model runs that used tokens — failed ones included, they cost us too. */
  answerCount: number;
  /** Of which the shop paid for (cost_uzs > 0). */
  paidAnswerCount: number;
  /** answerCount − paidAnswerCount: free allowance, failed runs, rows before 0125. */
  freeAnswerCount: number;
  /** Tokens of those same runs, in and out (what costUsd prices). */
  tokensIn: number;
  tokensOut: number;
  /** So'm taken from shops: sum(cost_uzs). */
  chargedUzs: number;
  /** Every run's tokens at the provider's list price, no margin. */
  costUsd: number;
  /** What the runs cost us in so'm (see botSpend for how). */
  costUzs: number;
  /** The part of costUzs spent on runs nobody paid for. */
  freeCostUzs: number;
  /** chargedUzs − costUzs; negative while free answers outweigh the margin. */
  marginUzs: number;
}

/** GET /platform/ai-assistant/summary */
export interface PlatformAiBotSummary extends PlatformAiBotSpend {
  /** The model the bot runs on now. */
  model: string;
  /** The rate the unpaid runs' so'm cost was converted at. */
  usdRate: number;
  topBusinesses: {
    businessId: string;
    name: string;
    answerCount: number;
    chargedUzs: number;
    costUzs: number;
    marginUzs: number;
  }[];
}

/** One SQL group: a shop's runs on one model, paid or not. */
export interface BotSpendGroup {
  businessId: string;
  name?: string | null;
  model: string | null;
  paid: boolean;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  chargedUzs: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * List price of these tokens, USD. The model is looked up in every
 * provider's table (the bot may have run on another provider then); a row
 * with no model (a failed run) or one missing from the tables is priced as
 * `provider`'s default model — the fallback answerCharge bills with.
 */
export function listCostUsd(
  model: string | null,
  tokensIn: number,
  tokensOut: number,
  provider: AiProviderId,
): number {
  const owner = model
    ? AI_PROVIDER_IDS.find((p) => PROVIDER_MODELS[p].some((m) => m.id === model))
    : undefined;
  return owner
    ? estimateCostUsd(model!, owner, tokensIn, tokensOut)
    : estimateCostUsd(defaultModelFor(provider), provider, tokensIn, tokensOut);
}

/**
 * The figures of a set of groups. Our so'm cost is two parts:
 *  - a paid run's is exact: it was charged its list cost plus
 *    SYSTEM_TOKEN_MARKUP at that day's rate (ai-usage.ts answerCharge), so
 *    its list cost then was cost_uzs / (1 + SYSTEM_TOKEN_MARKUP);
 *  - an unpaid run carries no rate, so its list cost is converted at
 *    `usdRate` (today's) — that part is approximate for old runs.
 * Rounded at the end, and the margin from the rounded figures, so that
 * marginUzs = chargedUzs − costUzs and freeCostUzs ≤ costUzs hold exactly.
 */
export function botSpend(
  groups: readonly BotSpendGroup[],
  opts: {usdRate: number; provider: AiProviderId},
): PlatformAiBotSpend {
  let answers = 0;
  let paidAnswers = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let charged = 0;
  let usd = 0;
  let paidCost = 0;
  let freeCost = 0;
  for (const g of groups) {
    const runUsd = listCostUsd(g.model, g.tokensIn, g.tokensOut, opts.provider);
    answers += g.runs;
    tokensIn += g.tokensIn;
    tokensOut += g.tokensOut;
    charged += g.chargedUzs;
    usd += runUsd;
    if (g.paid) {
      paidAnswers += g.runs;
      paidCost += g.chargedUzs / (1 + SYSTEM_TOKEN_MARKUP);
    } else {
      freeCost += runUsd * opts.usdRate;
    }
  }
  const chargedUzs = round2(charged);
  const freeCostUzs = round2(freeCost);
  const costUzs = round2(round2(paidCost) + freeCostUzs);
  return {
    answerCount: answers,
    paidAnswerCount: paidAnswers,
    freeAnswerCount: answers - paidAnswers,
    tokensIn,
    tokensOut,
    chargedUzs,
    costUsd: round6(usd),
    costUzs,
    freeCostUzs,
    marginUzs: round2(chargedUzs - costUzs),
  };
}

/** The whole platform's figures plus the shops with the most answers. */
export function botSummary(
  groups: readonly BotSpendGroup[],
  opts: {usdRate: number; provider: AiProviderId; model: string; top?: number},
): PlatformAiBotSummary {
  const byShop = new Map<string, BotSpendGroup[]>();
  for (const g of groups) {
    const list = byShop.get(g.businessId) ?? [];
    list.push(g);
    byShop.set(g.businessId, list);
  }
  const topBusinesses = [...byShop.entries()]
    .map(([businessId, list]) => {
      const s = botSpend(list, opts);
      return {
        businessId,
        name: list.find((g) => g.name)?.name ?? '',
        answerCount: s.answerCount,
        chargedUzs: s.chargedUzs,
        costUzs: s.costUzs,
        marginUzs: s.marginUzs,
      };
    })
    .sort(
      (a, b) =>
        b.answerCount - a.answerCount || a.businessId.localeCompare(b.businessId),
    )
    .slice(0, opts.top ?? 10);
  return {
    ...botSpend(groups, opts),
    model: opts.model,
    usdRate: opts.usdRate,
    topBusinesses,
  };
}
