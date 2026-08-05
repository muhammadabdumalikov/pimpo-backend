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
      yield this.toErrorEvent(err);
      return;
    }

    // Client disconnect and our own budget both abort the provider call.
    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    clientSignal.addEventListener('abort', onClientAbort);
    const budgetTimer = setTimeout(() => controller.abort(), ANSWER_BUDGET_MS);

    const ctx = {businessId, tier, today: this.today()};
    const sqlEnabled = this.aiSql.enabled;

    const toolDefs = [
      ...this.tools.listFor(tier),
      RENDER_TOOL,
      ...(sqlEnabled ? [SQL_TOOL] : []),
    ];

    const system = buildSystemPrompt({
      businessName: opts.businessName,
      locale: opts.locale,
      today: ctx.today,
      schemaDoc: sqlEnabled ? SQL_SCHEMA_DOC : null,
    });

    // Artifacts surface as their own SSE events, but the model produces them
    // through a tool call, so the executor has to hand them back out here.
    const pendingArtifacts: AiArtifact[] = [];

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
            yield {type: 'tool_end', id: event.id, ok: event.ok, ms: event.ms};
            // Flush any artifact the call just produced, so it lands in order
            // relative to the prose around it.
            while (pendingArtifacts.length) {
              yield {type: 'artifact', artifact: pendingArtifacts.shift()!};
            }
            break;

          case 'usage':
            this.logger.log(
              `ai.usage business=${businessId} in=${event.inputTokens} out=${event.outputTokens}`,
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

      await this.settings.recordUsage(businessId);
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

      yield this.toErrorEvent(err);
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

  private toErrorEvent(err: unknown): AiStreamEvent {
    const app =
      err instanceof AppException ? err : this.settings.toAppException(err);
    return {type: 'error', code: app.code, message: app.message};
  }
}
