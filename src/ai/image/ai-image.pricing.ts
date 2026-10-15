/**
 * Money and calendar arithmetic for AI product images (AI-RASM.md). Pure, so
 * the limits can be tested without a database or a Gemini key.
 *
 * Every figure is USD at Google's list price (ai.google.dev/gemini-api/docs/
 * pricing, read 2026-10-14). The shop never sees dollars (Q12) — it sees a
 * percentage and "≈ N images left", both derived here.
 */

/** A shop's monthly allowance when the platform console has not moved it (Q9). */
export const AI_IMAGE_DEFAULT_LIMIT_USD = 15;

/** Platform-wide monthly budget when AI_IMAGE_MONTHLY_BUDGET_USD is unset (Q10). */
export const AI_IMAGE_DEFAULT_BUDGET_USD = 100;

/** Default models; both are env-switchable without a deploy (Q11). */
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';
export const DEFAULT_DESCRIBE_MODEL = 'gemini-3.1-flash-lite';

/** Output tokens Google bills for one 1K (1024×1024) image. */
export const IMAGE_TOKENS_1K = 1120;

interface ImageModelPrice {
  /** USD per 1M input tokens (text and the shop's photo). */
  input: number;
  /** USD per 1M image output tokens. */
  imageOutput: number;
  /** USD per 1M text + thinking output tokens. */
  textOutput: number;
}

/**
 * Image-capable models we know the price of. 1K image = 1120 tokens, so
 * $30/M is the published $0.0336 per image and $120/M is Pro's $0.134.
 */
export const IMAGE_MODEL_PRICES: Readonly<Record<string, ImageModelPrice>> = {
  'gemini-nano-banana-2.1': {input: 1.5, imageOutput: 30, textOutput: 7.5},
  'gemini-3-pro-image': {input: 2, imageOutput: 120, textOutput: 12},
  // Deprecated 2026-10-06 in favour of 2.1; kept so an env still pointing at
  // it is charged correctly until it is switched.
  'gemini-3.1-flash-image': {input: 0.5, imageOutput: 60, textOutput: 3},
  // Text-output price is not published for Lite; Lite thinks minimally, so
  // the guess barely moves the total.
  'gemini-3.1-flash-lite-image': {
    input: 0.25,
    imageOutput: 30,
    textOutput: 1.5,
  },
};

/**
 * What an image call costs when the model is not in the table: deliberately
 * the dearest one (Pro at 1K plus thinking). A wrong env value should run a
 * shop out of allowance early, never let it spend for free.
 */
const UNKNOWN_MODEL_IMAGE_COST_USD = 0.15;

/** Thinking a typical image call spends, for the "≈ N left" estimate. */
const TYPICAL_THINKING_TOKENS = 1500;
/** Prompt + a downscaled photo, for the same estimate. */
const TYPICAL_INPUT_TOKENS = 1200;
/** The describe step that precedes most images (flash-lite, ~1k tokens). */
const TYPICAL_DESCRIBE_COST_USD = 0.0005;

export interface ImageCallUsage {
  inputTokens: number;
  imageTokens: number;
  /** Text output plus thinking. */
  textTokens: number;
}

/** USD for one image call at list price. */
export function imageCallCostUsd(model: string, usage: ImageCallUsage): number {
  const price = IMAGE_MODEL_PRICES[model];
  if (!price) {
    return usage.imageTokens > 0 ? UNKNOWN_MODEL_IMAGE_COST_USD : 0;
  }
  return (
    (usage.inputTokens * price.input) / 1e6 +
    (usage.imageTokens * price.imageOutput) / 1e6 +
    (usage.textTokens * price.textOutput) / 1e6
  );
}

/** What one more picture is expected to cost — describe step included. */
export function typicalImageCostUsd(model: string): number {
  const price = IMAGE_MODEL_PRICES[model];
  if (!price) return UNKNOWN_MODEL_IMAGE_COST_USD + TYPICAL_DESCRIBE_COST_USD;
  return (
    (TYPICAL_INPUT_TOKENS * price.input) / 1e6 +
    (IMAGE_TOKENS_1K * price.imageOutput) / 1e6 +
    (TYPICAL_THINKING_TOKENS * price.textOutput) / 1e6 +
    TYPICAL_DESCRIBE_COST_USD
  );
}

// ── Calendar (+05:00, the same month the AI counters roll over on) ─────────

const ZONE_OFFSET_MS = 5 * 3_600_000;

/** 'YYYY-MM' of the shop's month at `at`. */
export function periodOf(at: Date): string {
  return new Date(at.getTime() + ZONE_OFFSET_MS).toISOString().slice(0, 7);
}

/** The instant the shop's month `period` begins. */
export function periodStart(period: string): Date {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - ZONE_OFFSET_MS);
}

/** The instant the month after `period` begins — when the allowance resets. */
export function periodEnd(period: string): Date {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1) - ZONE_OFFSET_MS);
}

// ── Allowance ──────────────────────────────────────────────────────────────

export interface QuotaRow {
  monthlyLimitUsd: number | null;
  bonusUsd: number;
  bonusPeriod: string | null;
}

/** The shop's allowance for `period`: its limit plus a bonus granted for it. */
export function allowanceUsd(
  quota: QuotaRow | null | undefined,
  period: string,
): number {
  const base = quota?.monthlyLimitUsd ?? AI_IMAGE_DEFAULT_LIMIT_USD;
  const bonus =
    quota && quota.bonusPeriod === period ? Math.max(0, quota.bonusUsd) : 0;
  return Math.max(0, base) + bonus;
}

/** What the shop sees: no dollars, just how far along it is (Q12). */
export interface AiImageUsageView {
  /** 0–100, rounded down so it never claims 100 before it is spent. */
  percentUsed: number;
  /** Pictures the remaining allowance buys at the typical cost, rounded down. */
  approxImagesLeft: number;
  exhausted: boolean;
  /** ISO instant the allowance resets. */
  resetsAt: string;
}

export function usageView(
  spentUsd: number,
  allowance: number,
  model: string,
  period: string,
): AiImageUsageView {
  const exhausted = spentUsd >= allowance;
  const left = Math.max(0, allowance - spentUsd);
  const percentUsed =
    allowance > 0
      ? Math.min(100, Math.floor((spentUsd / allowance) * 100))
      : 100;
  return {
    percentUsed: exhausted ? 100 : percentUsed,
    approxImagesLeft: exhausted
      ? 0
      : Math.floor(left / typicalImageCostUsd(model)),
    exhausted,
    resetsAt: periodEnd(period).toISOString(),
  };
}

/**
 * Which budget alert (if any) this spend just crossed: 80 or 100 (% of the
 * platform budget). Returns the highest threshold `after` reached that
 * `before` had not, so one call never sends two alerts.
 */
export function crossedBudgetThreshold(
  beforeUsd: number,
  afterUsd: number,
  budgetUsd: number,
): 80 | 100 | null {
  if (budgetUsd <= 0) return null;
  for (const pct of [100, 80] as const) {
    const line = (budgetUsd * pct) / 100;
    if (afterUsd >= line && beforeUsd < line) return pct;
  }
  return null;
}
