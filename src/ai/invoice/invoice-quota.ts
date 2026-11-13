import type {AiProviderId} from '../providers/llm-provider.interface';

/**
 * The delivery-note scanner's monthly allowance on Pimpo's key.
 *
 * A shop that connected its own AI key (Settings → Ilovalar → AI) pays its
 * provider itself and scans without a cap. A shop without one scans on
 * Pimpo's key, and the plan sets how many pages a month that covers. The
 * landing's pricing matrix and the dashboard's plan cards quote these numbers
 * (`invoiceScan` rows) — change them together.
 */
export const INVOICE_PLATFORM_PAGES: Readonly<Record<string, number>> = {
  pro: 100,
  proplus: 500,
};

/** Pages a month on Pimpo's key for this plan; 0 = the plan has no scanner. */
export function platformPageLimit(tier: string): number {
  return INVOICE_PLATFORM_PAGES[tier] ?? 0;
}

/** Month's spend on Pimpo's key, across every shop, before reads pause. */
export const INVOICE_DEFAULT_BUDGET_USD = 100;

export type InvoiceKeySource = 'shop' | 'platform';

export interface InvoiceScanUsage {
  /** Whose key the next read runs on. */
  keySource: InvoiceKeySource;
  /** Pages a month on Pimpo's key; null on the shop's own key (no cap). */
  limit: number | null;
  /** Pages read on Pimpo's key this month. */
  used: number;
  /** Pages still available this month; null when there is no cap. */
  left: number | null;
  /** First day of next month (YYYY-MM-DD), when the count starts over. */
  resetsAt: string;
  /** False when neither key can run a read right now. */
  available: boolean;
}

/** How many of `pages` fit; a read is all-or-nothing, so false = refuse. */
export function fitsAllowance(
  limit: number,
  used: number,
  pages: number,
): boolean {
  return used + pages <= limit;
}

/** Pimpo's own provider/model/key for the scanner, from the environment. */
export function platformInvoiceConfig(
  env: NodeJS.ProcessEnv,
  ids: readonly AiProviderId[],
  defaultModelFor: (provider: AiProviderId) => string,
): {provider: AiProviderId; model: string; key: string | undefined} {
  const raw = (env.AI_INVOICE_PROVIDER || 'gemini').trim() as AiProviderId;
  const provider = ids.includes(raw) ? raw : 'gemini';
  const model = env.AI_INVOICE_MODEL?.trim() || defaultModelFor(provider);
  const key = {
    gemini: env.GEMINI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
  }[provider]?.trim();
  return {provider, model, key: key || undefined};
}
