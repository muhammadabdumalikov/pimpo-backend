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
  | {type: 'usage'; inputTokens: number; outputTokens: number}
  | {type: 'error'; message: string; retryable: boolean};

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
}

export interface LlmProvider {
  readonly id: AiProviderId;
  /** Emits deltas and tool progress; resolves when the answer is complete. */
  run(opts: LlmRunOptions): AsyncGenerator<LlmEvent, void, void>;
  /** Cheap auth/connectivity probe for the settings page's "Test" button. */
  test(signal?: AbortSignal): Promise<void>;
  /**
   * Chat-capable models this key can actually reach, newest first.
   *
   * Asking the provider beats shipping a hardcoded list: vendors retire models
   * without warning (Gemini 3 Pro Preview started 404-ing here), and a stale
   * constant turns that into a broken feature until we ship a release.
   */
  listModels(signal?: AbortSignal): Promise<LlmModelOption[]>;
}

/** Default cap on model round-trips per question (tool calls + final answer). */
export const DEFAULT_MAX_ITERATIONS = 8;

/** Output-token ceiling per model turn. Streaming, so this is generous. */
export const MAX_OUTPUT_TOKENS = 8000;

/**
 * Fallback suggestions shown before a key is saved, or if listing models fails.
 *
 * These are SUGGESTIONS, not a validation allowlist. The live list from
 * `listModels()` is authoritative; this exists only so the dropdown has
 * something in it on a fresh install. Any entry here can go stale at any time —
 * that is exactly why `isValidModelId` below does not consult it.
 */
export const PROVIDER_MODELS: Record<AiProviderId, LlmModelOption[]> = {
  anthropic: [
    {id: 'claude-opus-5', label: 'Claude Opus 5'},
    {id: 'claude-sonnet-5', label: 'Claude Sonnet 5'},
    {id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5'},
  ],
  openai: [
    {id: 'gpt-5.2', label: 'GPT-5.2'},
    {id: 'gpt-5-mini', label: 'GPT-5 mini'},
  ],
  gemini: [
    {id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro'},
    {id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash'},
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
