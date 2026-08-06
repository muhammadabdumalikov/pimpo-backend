/**
 * Provider-agnostic contract for the AI assistant.
 *
 * The assistant is BYOK — a business plugs in their own Anthropic, OpenAI, or
 * Gemini key — so everything above this interface (tool registry, SSE
 * orchestration, artifact shaping) is written once and works on all three.
 *
 * Each adapter drives its own tool-calling loop natively (Anthropic
 * `tool_use` blocks, OpenAI function calling, Gemini `functionDeclarations`)
 * and normalises the result into the `LlmEvent` stream below. We deliberately
 * do NOT route one provider through another's compatibility shim: those shims
 * routinely drop streaming, tool-call, or usage detail.
 */

export type AiProviderId = 'anthropic' | 'openai' | 'gemini';

export const AI_PROVIDER_IDS: readonly AiProviderId[] = [
  'anthropic',
  'openai',
  'gemini',
] as const;

/** JSON Schema object describing a tool's arguments. */
export type JsonSchemaObject = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  /**
   * This tool's result tells the model nothing it can reason about — it only
   * puts something on the owner's screen (`render_result` returns
   * `{rendered: true}`). Adapters use it to end the loop early; see
   * `turnEndsHere`. Never sent to a provider: each adapter copies only name,
   * description and parameters into its own tool shape.
   */
  displayOnly?: boolean;
}

/**
 * True when the turn just streamed already contains the finished answer, so the
 * loop can stop instead of buying another round-trip.
 *
 * Why this exists: the answer used to always cost three model calls — one to
 * fetch a report, one to call `render_result`, one to write the prose. The
 * third bought nothing but the prose, while re-sending the whole ~4.3k-token
 * prefix. The prompt now asks for the prose and the render call in one turn,
 * and this collapses that case to two calls (~33% less input per question).
 *
 * Every condition below is a guard against truncating a real answer. When any
 * of them fails the loop simply continues, which is exactly the old behaviour —
 * so a model that ignores the prompt costs what it always did rather than
 * getting cut off mid-sentence.
 */
export function turnEndsHere(
  turnText: string,
  calls: {name: string; ok: boolean}[],
  displayOnly: ReadonlySet<string>,
): boolean {
  // No calls at all is already handled by the adapters (the run just ends).
  if (!calls.length) return false;
  // A failed call is a message TO the model — `render_result` answers a bad
  // payload with "that did not match the schema", and the whole point is that
  // the model reads it and retries. Cutting the loop here swallows the retry
  // and the owner silently gets prose with no table or chart.
  if (calls.some((c) => !c.ok)) return false;
  // A real tool ran, so the model is still gathering — it must see the result.
  if (!calls.every((c) => displayOnly.has(c.name))) return false;

  const text = turnText.trim();
  // Rendered but said nothing yet: the model still owes the owner an answer.
  if (!text) return false;
  // "Bu oy sotuvlaringiz:" is a lead-in promising more, not an answer.
  if (text.endsWith(':')) return false;
  // At least one finished sentence. Uzbek, Russian and English all end on
  // these, so this needs no per-locale handling.
  return /[.!?]/.test(text);
}

/** The subset of `tools` whose results the model never needs to read. */
export function displayOnlyNames(tools: LlmToolDef[]): ReadonlySet<string> {
  return new Set(tools.filter((t) => t.displayOnly).map((t) => t.name));
}

/** One prior turn. Tool traffic is not replayed — only the visible text is. */
export interface LlmTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type LlmEvent =
  | {type: 'text'; delta: string}
  | {
      type: 'tool_start';
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {type: 'tool_end'; id: string; name: string; ok: boolean; ms: number}
  | LlmUsageEvent
  | {type: 'error'; message: string; retryable: boolean};

/**
 * One model round-trip's token cost, normalised across the three providers.
 *
 * Getting this shape right matters more than it looks: this feature re-sends a
 * large stable prefix (system prompt + ~27 tool schemas) on every iteration of
 * the tool loop, so input dominates the bill — measured at roughly 19x output.
 * Two provider quirks were silently hiding real spend before this event carried
 * the extra fields:
 *
 *   • Gemini and OpenAI report reasoning tokens SEPARATELY from the answer
 *     tokens, but bill them as output. Logging only `candidatesTokenCount` /
 *     `completion_tokens` therefore under-reports what was actually charged.
 *   • Anthropic's `input_tokens` EXCLUDES cache traffic — total input is
 *     `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
 *
 * `inputTokens` is always the FULL billable input, cache included, so the three
 * providers stay comparable.
 */
export interface LlmUsageEvent {
  type: 'usage';
  /** Every input token in the request, including any served from cache. */
  inputTokens: number;
  /** Answer tokens plus reasoning tokens — the whole output charge. */
  outputTokens: number;
  /** Subset of `inputTokens` served from the prompt cache, billed cheaper. */
  cachedInputTokens?: number;
  /** Subset of `outputTokens` spent on reasoning the owner never sees. */
  thinkingTokens?: number;
}

export interface LlmRunOptions {
  /** Stable, cacheable prefix: persona + schema/tool guidance + locale. */
  system: string;
  /** Prior turns, oldest first. */
  history: LlmTurn[];
  /** The question being asked now. */
  question: string;
  tools: LlmToolDef[];
  /**
   * Executes a tool and returns a JSON-serialisable result. Rejections are
   * turned into an error result for the model rather than aborting the run —
   * the model can then try a different tool or explain the gap.
   *
   * Declared as a property rather than a method so adapters can destructure it
   * off `opts` without picking up an unbound `this`.
   */
  executeTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ok: boolean; result: unknown}>;
  signal: AbortSignal;
  /** Hard ceiling on model round-trips, to bound cost and latency. */
  maxIterations?: number;
}

export interface LlmModelOption {
  id: string;
  label: string;
  /**
   * List price in USD per 1M tokens, for the running spend estimate on the
   * settings page. Omitted for a model we have no published price for (a
   * hand-typed id, say) — then the page shows tokens without a figure rather
   * than an invented one.
   *
   * Vendors that tier by context length are quoted at their SMALL-context rate:
   * a question here runs ~10-20k tokens, nowhere near the 200k boundary.
   */
  usdPer1M?: {input: number; output: number};
}

/**
 * Margin added when the tokens came out of Pimpo's own provider account rather
 * than the shop's. BYOK questions are quoted at bare list price — the shop is
 * billed by the vendor directly and we take nothing.
 */
export const SYSTEM_TOKEN_MARKUP = 0.25;

/**
 * Estimated USD cost of one question. Returns 0 for an unpriced model, so the
 * running total simply does not move rather than drifting on a guess.
 *
 * @param systemKey true when Pimpo supplied the key, which applies
 *   SYSTEM_TOKEN_MARKUP on top of list price.
 */
export function estimateCostUsd(
  model: string,
  provider: AiProviderId,
  inputTokens: number,
  outputTokens: number,
  systemKey = false,
): number {
  const price = PROVIDER_MODELS[provider]?.find(
    (m) => m.id === model,
  )?.usdPer1M;
  if (!price) return 0;
  const list =
    (inputTokens * price.input) / 1e6 + (outputTokens * price.output) / 1e6;
  return systemKey ? list * (1 + SYSTEM_TOKEN_MARKUP) : list;
}

export interface LlmProvider {
  readonly id: AiProviderId;
  /** Emits deltas and tool progress; resolves when the answer is complete. */
  run(opts: LlmRunOptions): AsyncGenerator<LlmEvent, void, void>;
  /** Cheap auth/connectivity probe for the settings page's "Test" button. */
  test(signal?: AbortSignal): Promise<void>;
}

/** Default cap on model round-trips per question (tool calls + final answer). */
export const DEFAULT_MAX_ITERATIONS = 8;

/** Output-token ceiling per model turn. Streaming, so this is generous. */
export const MAX_OUTPUT_TOKENS = 8000;

/**
 * The models offered in the picker. Hand-curated on purpose.
 *
 * We used to fetch this live from each provider. It worked, but every vendor
 * ships its whole catalogue through one endpoint — image, video, music (Lyria
 * showed up in a shop owner's dropdown), embeddings, realtime, robotics, plus a
 * dozen near-identical dated snapshots of each chat model. Filtering that down
 * was an endless game of naming families to exclude, and it still left ~9
 * near-duplicate entries for someone who just wants "the cheap one".
 *
 * ── UPDATING THIS LIST ───────────────────────────────────────────────────────
 * Add or remove entries here when a vendor ships something worth offering:
 *   Anthropic  https://docs.claude.com/en/docs/about-claude/models/overview
 *   OpenAI     https://platform.openai.com/docs/models
 *   Gemini     https://ai.google.dev/gemini-api/docs/models
 * Keep the cheapest capable model FIRST — see SHIP.md for why that choice is
 * worth roughly the price of the shop's own subscription.
 *
 * ── WHY GOING STALE IS SAFE ──────────────────────────────────────────────────
 * These are SUGGESTIONS, never a validation allowlist. `isValidModelId` below
 * checks shape only, the settings page lets an owner type any id by hand, and
 * a retired id comes back from the provider as a 404 we surface as
 * AI_UNKNOWN_MODEL. So a list that is a release behind costs a manual entry —
 * it cannot brick the feature, which is what the old validating allowlist did.
 *
 * ORDER IS A COST DECISION. The first entry is what the settings page presents
 * first, and the owner pays for it out of their own account. Measured on real
 * traffic, one question costs ~19.7k input / ~1k output tokens, so at 30
 * questions a day a frontier model runs to roughly the price of the Pimpo
 * subscription itself while a mid-tier one costs a fraction of it. The work —
 * pick one of ~27 report tools, read its totals, write three sentences — does
 * not need a frontier model, so the cheap capable option leads and the
 * expensive ones stay one click away.
 */
export const PROVIDER_MODELS: Record<AiProviderId, LlmModelOption[]> = {
  anthropic: [
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      usdPer1M: {input: 3, output: 15},
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      usdPer1M: {input: 1, output: 5},
    },
    {
      id: 'claude-opus-5',
      label: 'Claude Opus 5',
      usdPer1M: {input: 5, output: 25},
    },
  ],
  openai: [
    {
      id: 'gpt-5-mini',
      label: 'GPT-5 mini',
      usdPer1M: {input: 0.25, output: 2},
    },
    {id: 'gpt-5.2', label: 'GPT-5.2', usdPer1M: {input: 1.75, output: 14}},
  ],
  // ⚠️ ON GEMINI, A MODEL BEING LISTED DOES NOT MEAN IT CAN BE CALLED.
  // `models.list` still returns the whole 2.5 generation, and the pricing page
  // still quotes it, but generateContent answers:
  //   404 "This model models/gemini-2.5-flash is no longer available to new
  //        users. Please update your code to use a newer model."
  // Google keeps retired models reachable for accounts that already used them
  // and closes them to everyone else, so neither the docs, the price list, nor
  // the catalogue endpoint proves an id works — only an actual call does. The
  // whole 2.5 line is therefore out.
  //
  // Lite leads on measured behaviour, not just price. Asked the same question,
  // 3.1 Flash Lite took the ideal path — one branch_comparison, then
  // render_result, 2 calls / 10.1k input / 2.6s — while a thinking Flash model
  // called the same tool twice, rendered nothing at all, and spent 3 calls /
  // 16.3k input / 12.8s. Thirteen times cheaper AND more correct, because this
  // job is "pick one of ~26 tools and read its totals", which rewards following
  // instructions over reasoning. The expectation that Lite would fumble tool
  // choice was simply wrong; keep `ai.answer`'s tool sequence honest about it.
  gemini: [
    {
      id: 'gemini-3.1-flash-lite',
      label: 'Gemini 3.1 Flash Lite',
      usdPer1M: {input: 0.25, output: 1.5},
    },
    {
      id: 'gemini-3.5-flash-lite',
      label: 'Gemini 3.5 Flash Lite',
      usdPer1M: {input: 0.3, output: 2.5},
    },
    {
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      usdPer1M: {input: 1.5, output: 7.5},
    },
    {
      id: 'gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      usdPer1M: {input: 1.5, output: 9},
    },
    {
      id: 'gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro',
      usdPer1M: {input: 2, output: 12},
    },
  ],
};

export function defaultModelFor(provider: AiProviderId): string {
  return PROVIDER_MODELS[provider][0].id;
}

/**
 * Shape check only — deliberately NOT an allowlist.
 *
 * This is BYOK: the shop pays for its own tokens on its own provider account,
 * so gatekeeping which model they may pick is both presumptuous and fragile.
 * An allowlist means every vendor release or retirement bricks the feature
 * until we ship code. The provider is the real validator: an unknown model id
 * comes back as a 404 we surface as AI_UNKNOWN_MODEL.
 */
export function isValidModelId(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-:/]{1,59}$/.test(model);
}
