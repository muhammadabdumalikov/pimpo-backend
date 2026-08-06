import {CACHE_MANAGER} from '@nestjs/cache-manager';
import {Inject, Injectable, Logger} from '@nestjs/common';
import {Cache} from 'cache-manager';
import {AiSqlService} from '../ai-sql/ai-sql.service';
import {SQL_SCHEMA_DOC, SQL_TOOL, SQL_TOOL_NAME} from '../ai-sql/sql-tool';
import {CacheKeys, TTL} from '../cache/cache.util';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {SubscriptionService} from '../subscription/subscription.service';
import {AiSettingsService} from './ai-settings.service';
import {
  AiArtifact,
  RENDER_TOOL,
  RENDER_TOOL_NAME,
  parseArtifact,
} from './artifact';
import {AiLocale, buildSystemPrompt} from './prompt';
import {LlmProvider, LlmTurn} from './providers/llm-provider.interface';
import {Tier} from '../subscription/tier';
import {AiToolsService} from './tools/ai-tools.service';

/** Dropped from the tool list when the branch roster is inlined instead. */
const LIST_BRANCHES_TOOL = 'list_branches';

/** Questions one business may ask per hour. Protects a 2 vCPU host. */
const HOURLY_LIMIT = 20;
/** Wall-clock budget for a whole answer, including every tool round-trip. */
const ANSWER_BUDGET_MS = 90_000;

/** What the controller serialises onto the SSE wire. */
export type AiStreamEvent =
  | {type: 'text'; delta: string}
  | {type: 'tool_start'; id: string; name: string; label: string}
  | {type: 'tool_end'; id: string; ok: boolean; ms: number}
  | {type: 'artifact'; artifact: AiArtifact}
  | {type: 'error'; code: string; message: string}
  | {type: 'done'};

export interface AskOptions {
  businessId: string;
  businessName: string;
  locale: AiLocale;
  question: string;
  history: LlmTurn[];
  /** Per-question model override; falls back to the business's saved model. */
  model?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly settings: AiSettingsService,
    private readonly tools: AiToolsService,
    private readonly subscriptions: SubscriptionService,
    private readonly aiSql: AiSqlService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Today in the business zone (+05:00), YYYY-MM-DD. */
  private today(): string {
    return new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
  }

  /**
   * Fixed-window hourly counter.
   *
   * The window boundary is a little blunt compared to a sliding log, but it is
   * one Redis round-trip and the failure it guards against — a user holding a
   * refresh key down — is stopped either way.
   */
  private async checkRateLimit(businessId: string): Promise<void> {
    const bucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const key = CacheKeys.aiRate(businessId, bucket);
    const used = (await this.cache.get<number>(key)) ?? 0;

    if (used >= HOURLY_LIMIT) throw new AppException(ErrorCode.AI_RATE_LIMITED);
    await this.cache.set(key, used + 1, TTL.AI_RATE);
  }

  /**
   * Answers one question, emitting UI events as they happen.
   *
   * Errors are yielded rather than thrown once the stream has started: by then
   * the HTTP response is already 200 with an open event stream, so a thrown
   * exception would just cut the connection with nothing for the UI to show.
   */
  async *ask(
    opts: AskOptions,
    clientSignal: AbortSignal,
  ): AsyncGenerator<AiStreamEvent, void, void> {
    const {businessId} = opts;

    // Everything that can fail before a token is spent, fails here.
    let provider: LlmProvider;
    let tier: Tier;
    try {
      await this.checkRateLimit(businessId);
      tier = await this.subscriptions.getEffectiveTier(businessId);
      provider = await this.settings.resolveProvider(businessId, opts.model);
    } catch (err) {
      yield this.toErrorEvent(err, opts.model);
      return;
    }

    // Client disconnect and our own budget both abort the provider call.
    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    clientSignal.addEventListener('abort', onClientAbort);
    const budgetTimer = setTimeout(() => controller.abort(), ANSWER_BUDGET_MS);

    const ctx = {businessId, tier, today: this.today()};
    const sqlEnabled = this.aiSql.enabled;

    // Handing the model the branch ids up front is strictly cheaper than making
    // it ask: the roster costs a few tokens per request, the lookup cost a whole
    // round-trip. When it is inlined the tool becomes dead weight and a
    // temptation, so it comes out of the list entirely.
    const branches = await this.tools.branchesForPrompt(businessId);
    const toolDefs = [
      ...this.tools
        .listFor(tier)
        .filter((t) => !(branches && t.name === LIST_BRANCHES_TOOL)),
      RENDER_TOOL,
      ...(sqlEnabled ? [SQL_TOOL] : []),
    ];

    const system = buildSystemPrompt({
      businessName: opts.businessName,
      locale: opts.locale,
      today: ctx.today,
      schemaDoc: sqlEnabled ? SQL_SCHEMA_DOC : null,
      branches,
    });

    // Artifacts surface as their own SSE events, but the model produces them
    // through a tool call, so the executor has to hand them back out here.
    const pendingArtifacts: AiArtifact[] = [];

    // Token spend across every round-trip of this one question.
    const spent = {input: 0, output: 0, cached: 0, thinking: 0, calls: 0};
    /** Tool names in call order, for the closing summary line. */
    const trace: string[] = [];
    /** Artifacts that parsed and reached the browser. */
    let renderedArtifacts = 0;
    const startedAt = Date.now();

    const stream = provider.run({
      system,
      history: opts.history,
      question: opts.question,
      tools: toolDefs,
      signal: controller.signal,
      executeTool: async (name, args) => {
        if (name === RENDER_TOOL_NAME) {
          const artifact = parseArtifact(args);
          if (!artifact) {
            return {
              ok: false,
              result: {
                error:
                  'That payload did not match the schema. Check that a kpi has items, a table has columns, and a chart has categories and series.',
              },
            };
          }
          pendingArtifacts.push(artifact);
          renderedArtifacts += 1;
          return {ok: true, result: {rendered: true}};
        }
        if (name === SQL_TOOL_NAME) return this.runSql(businessId, args);
        return this.tools.execute(ctx, name, args);
      },
    });

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'text':
            yield {type: 'text', delta: event.delta};
            break;

          case 'tool_start':
            yield {
              type: 'tool_start',
              id: event.id,
              name: event.name,
              label:
                event.name === RENDER_TOOL_NAME
                  ? 'Natijani chizyapman'
                  : this.tools.labelFor(event.name),
            };
            break;

          case 'tool_end':
            // Recorded so the closing `ai.answer` line shows WHICH tools ran.
            // Cost here is driven almost entirely by the number of round-trips,
            // and without the sequence there is no way to tell a question that
            // genuinely needs five tools from one where the model failed to
            // find the single tool built for it.
            trace.push(`${event.name}${event.ok ? '' : '!'}`);
            yield {type: 'tool_end', id: event.id, ok: event.ok, ms: event.ms};
            // Flush any artifact the call just produced, so it lands in order
            // relative to the prose around it.
            while (pendingArtifacts.length) {
              yield {type: 'artifact', artifact: pendingArtifacts.shift()!};
            }
            break;

          case 'usage':
            // Per round-trip, plus a running total: one question is several
            // model calls, and it is the TOTAL that shows up on the owner's
            // provider bill. `cached` is the diagnostic that matters most —
            // this feature re-sends a ~5.5k-token prefix every iteration, so a
            // cached figure stuck at 0 means we are paying full price for it.
            spent.input += event.inputTokens;
            spent.output += event.outputTokens;
            spent.cached += event.cachedInputTokens ?? 0;
            spent.thinking += event.thinkingTokens ?? 0;
            spent.calls += 1;
            // `log`, not `debug`: Nest drops debug lines under some production
            // logger configs, and this is the number the owner gets billed for.
            this.logger.log(
              `ai.call #${spent.calls} business=${businessId} in=${event.inputTokens}` +
                ` out=${event.outputTokens} cached=${event.cachedInputTokens ?? 0}` +
                ` thinking=${event.thinkingTokens ?? 0}`,
            );
            break;

          case 'error':
            yield {
              type: 'error',
              code: ErrorCode.AI_PROVIDER_UNAVAILABLE,
              message: event.message,
            };
            break;
        }
      }

      // A model that renders last and then stops emits no further tool_end.
      while (pendingArtifacts.length) {
        yield {type: 'artifact', artifact: pendingArtifacts.shift()!};
      }

      // One line per question — the unit the owner is actually billed in.
      // Counted from artifacts the owner actually received, NOT from the trace:
      // a rejected payload still shows up there (as `render_result!`) and would
      // otherwise be reported as a rendered result.
      const rendered = renderedArtifacts;
      this.logger.log(
        `ai.answer business=${businessId} calls=${spent.calls} ms=${Date.now() - startedAt}` +
          ` in=${spent.input} out=${spent.output} cached=${spent.cached} thinking=${spent.thinking}` +
          ` artifacts=${rendered} tools=[${trace.join(' → ') || 'none'}]`,
      );
      // The whole promise of this feature is "text AND a real component". A
      // model that answers in prose alone still looks fine in the log line
      // above, so it gets called out here — silently degrading to a wall of
      // digits is the failure mode nobody notices until a shop owner complains.
      if (!rendered && trace.length) {
        this.logger.warn(
          `ai.answer business=${businessId} produced no artifact after [${trace.join(' → ')}]`,
        );
      }

      await this.settings.recordUsage(businessId, {
        input: spent.input,
        output: spent.output,
        // The model that actually ran, which is the per-question override when
        // one was given rather than the business's saved default.
        model: opts.model ?? (await this.settings.getView(businessId)).model,
      });
      yield {type: 'done'};
    } catch (err) {
      if (controller.signal.aborted && !clientSignal.aborted) {
        yield {
          type: 'error',
          code: ErrorCode.AI_TIMEOUT,
          message: 'The assistant ran out of time.',
        };
        return;
      }
      // Client hung up: nothing is listening, so there is nothing to report.
      if (clientSignal.aborted) return;

      yield this.toErrorEvent(err, opts.model);
    } finally {
      clearTimeout(budgetTimer);
      clientSignal.removeEventListener('abort', onClientAbort);
    }
  }

  /**
   * The ad-hoc SQL escape hatch.
   *
   * Failures come back as a *successful* tool result carrying the Postgres
   * error, because that is what lets the model repair its own query — throwing
   * here would end the answer on the first `::numeric` mistake. The number of
   * attempts is bounded by the provider's iteration cap, not by a counter here.
   */
  private async runSql(
    businessId: string,
    args: Record<string, unknown>,
  ): Promise<{ok: boolean; result: unknown}> {
    const sql = typeof args.sql === 'string' ? args.sql : '';
    if (!sql.trim()) {
      return {ok: false, result: {error: 'No SQL was provided.'}};
    }

    try {
      const result = await this.aiSql.runReadOnly(businessId, sql);
      this.logger.log(
        `ai.sql business=${businessId} ok rows=${result.rowCount} ms=${result.ms} :: ${sql.replace(/\s+/g, ' ').slice(0, 300)}`,
      );
      return {ok: true, result};
    } catch (err) {
      const detail = this.aiSql.describeFailure(err);
      this.logger.warn(
        `ai.sql business=${businessId} failed ${detail.code}: ${detail.message} :: ${sql.replace(/\s+/g, ' ').slice(0, 300)}`,
      );
      // Returned as a normal result, not an error: the model reads this and
      // retries. The owner never sees any of it.
      return {
        ok: false,
        result: {
          error: detail.message,
          code: detail.code,
          hint: detail.hint,
        },
      };
    }
  }

  /**
   * @param model the model that was asked for, logged alongside the failure.
   *   AI_UNKNOWN_MODEL without it is unactionable: the owner reports "model not
   *   found" and nothing on the server says which id the provider rejected.
   */
  private toErrorEvent(err: unknown, model?: string): AiStreamEvent {
    const app =
      err instanceof AppException ? err : this.settings.toAppException(err);
    this.logger.warn(
      `ai.error code=${app.code} model=${model ?? 'default'}: ${app.message}`,
    );
    return {type: 'error', code: app.code, message: app.message};
  }
}
