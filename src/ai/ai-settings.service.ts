import {Injectable, Logger} from '@nestjs/common';
import {eq} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DatabaseService} from '../database/database.service';
import {aiSettings} from '../database/schema';
import {SaveAiSettingsDto} from './dto/save-ai-settings.dto';
import {
  decryptSecret,
  encryptSecret,
  isEncryptionConfigured,
  keyLast4,
} from './crypto.util';
import {
  AiProviderId,
  LlmModelOption,
  LlmProvider,
  PROVIDER_MODELS,
  isValidModelId,
  estimateCostUsd,
} from './providers/llm-provider.interface';
import {createProvider} from './providers/provider.factory';

/** What the settings endpoints return. Never carries the key itself. */
export interface AiSettingsView {
  provider: AiProviderId;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  apiKeyLast4: string | null;
  monthlyCount: number;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  /**
   * Approximate USD spend this month, from our own price table — the provider's
   * invoice is the authority. Questions answered on a model we have no price
   * for add tokens but no cost, which `monthlyCostPartial` flags so the UI can
   * say "at least this much" instead of quietly under-reporting.
   */
  monthlyCostUsd: number;
  monthlyCostPartial: boolean;
  lastUsedAt: Date | null;
  /** Catalogue for the model dropdown, so the UI has one source of truth. */
  availableModels: Record<AiProviderId, {id: string; label: string}[]>;
}

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);

  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * This month's counters, or zeros when the stored ones belong to an earlier
   * period. They are only reset lazily (on the next question), so reading them
   * without this check would show last month's totals all through the 1st.
   */
  private periodUsage(
    row: {
      monthlyPeriod: string | null;
      monthlyCount: number;
      monthlyInputTokens: number;
      monthlyOutputTokens: number;
      monthlyCostUsd: number;
      provider: string;
      model: string;
    } | null,
  ): {
    monthlyCount: number;
    monthlyInputTokens: number;
    monthlyOutputTokens: number;
    monthlyCostUsd: number;
    monthlyCostPartial: boolean;
  } {
    const empty = {
      monthlyCount: 0,
      monthlyInputTokens: 0,
      monthlyOutputTokens: 0,
      monthlyCostUsd: 0,
      monthlyCostPartial: false,
    };
    if (!row || row.monthlyPeriod !== this.currentPeriod()) return empty;

    // Detects the realistic gap — the owner is running a hand-typed model we
    // have no price for. It cannot catch a month that MIXED priced and unpriced
    // models; that would need a per-question column, which is more bookkeeping
    // than an approximate figure is worth.
    const priced = PROVIDER_MODELS[row.provider as AiProviderId]?.some(
      (m) => m.id === row.model && m.usdPer1M,
    );
    return {
      monthlyCount: row.monthlyCount,
      monthlyInputTokens: row.monthlyInputTokens,
      monthlyOutputTokens: row.monthlyOutputTokens,
      monthlyCostUsd: row.monthlyCostUsd,
      monthlyCostPartial:
        !priced || (row.monthlyInputTokens > 0 && row.monthlyCostUsd === 0),
    };
  }

  private currentPeriod(): string {
    // Business zone (+05:00) so the monthly counter rolls over at local midnight.
    const local = new Date(Date.now() + 5 * 3_600_000);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  async getRow(businessId: string) {
    const [row] = await this.db
      .select()
      .from(aiSettings)
      .where(eq(aiSettings.businessId, businessId))
      .limit(1);
    return row ?? null;
  }

  async getView(businessId: string): Promise<AiSettingsView> {
    const row = await this.getRow(businessId);
    return {
      provider: (row?.provider as AiProviderId) ?? 'anthropic',
      model: row?.model ?? PROVIDER_MODELS.anthropic[0].id,
      enabled: row?.enabled ?? false,
      hasKey: Boolean(row?.apiKeyCipher),
      apiKeyLast4: row?.apiKeyLast4 ?? null,
      // A stale period means last month's numbers — report zeros rather than
      // showing figures the owner will read as "this month".
      ...this.periodUsage(row),
      lastUsedAt: row?.lastUsedAt ?? null,
      availableModels: PROVIDER_MODELS,
    };
  }

  async save(
    businessId: string,
    dto: SaveAiSettingsDto,
  ): Promise<AiSettingsView> {
    if (!isEncryptionConfigured()) {
      throw new AppException(ErrorCode.AI_ENCRYPTION_UNAVAILABLE);
    }
    if (!isValidModelId(dto.model)) {
      throw new AppException(ErrorCode.AI_UNKNOWN_MODEL, {
        model: dto.model,
        provider: dto.provider,
      });
    }

    const existing = await this.getRow(businessId);
    const rawKey = dto.apiKey?.trim();

    // No key in the payload and none stored: nothing to save yet. This is what
    // makes "change the model without re-typing the key" work.
    if (!rawKey && !existing?.apiKeyCipher) {
      throw new AppException(ErrorCode.AI_NOT_CONFIGURED);
    }

    const cipher = rawKey ? encryptSecret(rawKey) : existing.apiKeyCipher;
    const last4 = rawKey ? keyLast4(rawKey) : existing.apiKeyLast4;
    const enabled = dto.enabled ?? true;

    if (existing) {
      await this.db
        .update(aiSettings)
        .set({
          provider: dto.provider,
          model: dto.model,
          apiKeyCipher: cipher,
          apiKeyLast4: last4,
          enabled,
          updatedAt: new Date(),
        })
        .where(eq(aiSettings.businessId, businessId));
    } else {
      await this.db.insert(aiSettings).values({
        businessId,
        provider: dto.provider,
        model: dto.model,
        apiKeyCipher: cipher,
        apiKeyLast4: last4,
        enabled,
      });
    }

    return this.getView(businessId);
  }

  async remove(businessId: string): Promise<void> {
    await this.db
      .delete(aiSettings)
      .where(eq(aiSettings.businessId, businessId));
  }

  /**
   * Builds a ready-to-use provider for this business.
   *
   * Throws a localizable AppException when the assistant is unusable, so the
   * frontend can route the owner to the settings page instead of showing a
   * generic failure.
   *
   * `modelOverride` lets the chat screen switch model per question without
   * touching the saved default — the provider (and therefore the key) is fixed,
   * only the model varies. An unusable override surfaces as the provider's own
   * 404 → AI_UNKNOWN_MODEL, so a bad pick is recoverable in one click.
   */
  async resolveProvider(
    businessId: string,
    modelOverride?: string,
  ): Promise<LlmProvider> {
    if (!isEncryptionConfigured()) {
      throw new AppException(ErrorCode.AI_ENCRYPTION_UNAVAILABLE);
    }

    const row = await this.getRow(businessId);
    if (!row?.apiKeyCipher) throw new AppException(ErrorCode.AI_NOT_CONFIGURED);
    if (!row.enabled) throw new AppException(ErrorCode.AI_DISABLED);

    let apiKey: string;
    try {
      apiKey = decryptSecret(row.apiKeyCipher);
    } catch (err) {
      // A key that no longer decrypts means AI_KEY_ENCRYPTION_SECRET changed.
      // Surfacing "not configured" sends the owner to re-enter it, which is the
      // only fix — the plaintext is unrecoverable.
      this.logger.error(
        `Could not decrypt the stored key for business ${businessId}: ${
          (err as Error).message
        }`,
      );
      throw new AppException(ErrorCode.AI_NOT_CONFIGURED);
    }

    const model =
      modelOverride && isValidModelId(modelOverride)
        ? modelOverride
        : row.model;

    return createProvider(row.provider as AiProviderId, apiKey, model);
  }

  /** Validates a key against the provider without storing anything. */
  async testConnection(
    provider: AiProviderId,
    model: string,
    apiKey: string,
  ): Promise<void> {
    if (!isValidModelId(model)) {
      throw new AppException(ErrorCode.AI_UNKNOWN_MODEL, {model, provider});
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      await createProvider(provider, apiKey, model).test(controller.signal);
    } catch (err) {
      // Logged with the exact pair that failed. "Model not found" on its own is
      // unactionable — an id can be present in the vendor's catalogue and still
      // 404 for a given key, and without this line there is no way to tell that
      // apart from the id simply being wrong.
      const status = (err as {status?: number})?.status;
      this.logger.warn(
        `ai.test failed provider=${provider} model=${model} status=${status ?? '?'}: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
      throw this.toAppException(err);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Maps an SDK error onto our code registry. All three SDKs expose an HTTP
   * `status`, so one shape covers them; anything unrecognised is treated as a
   * provider outage rather than leaking the raw message to the owner.
   */
  toAppException(err: unknown): AppException {
    if (err instanceof AppException) return err;

    const status =
      (err as {status?: number; statusCode?: number})?.status ??
      (err as {statusCode?: number})?.statusCode;

    if (status === 401 || status === 403) {
      return new AppException(ErrorCode.AI_PROVIDER_AUTH_FAILED);
    }
    if (status === 429) return new AppException(ErrorCode.AI_RATE_LIMITED);
    // 404 from any of the three providers means the model id is wrong or has
    // been retired (Gemini 3 Pro Preview did exactly this). Saying "unknown
    // model" sends the owner to the dropdown; "provider unavailable" would
    // send them to check their internet connection instead.
    if (status === 404) {
      return new AppException(ErrorCode.AI_UNKNOWN_MODEL, {
        model: '',
        provider: '',
      });
    }

    this.logger.warn(
      `AI provider call failed: ${(err as Error)?.message ?? String(err)}`,
    );
    return new AppException(ErrorCode.AI_PROVIDER_UNAVAILABLE);
  }

  /**
   * Models offered for this business's configured provider.
   *
   * Reads the curated catalogue rather than asking the vendor. Fetching it live
   * meant every provider's full product line landed in a shop owner's dropdown —
   * image, video, music, embedding and realtime models alongside a dozen dated
   * snapshots of each chat model — and no amount of filtering made that a list
   * someone could choose from. See PROVIDER_MODELS for how to keep it current
   * and why a stale entry is harmless.
   *
   * Takes no key, so it is safe for staff accounts: they may switch model but
   * must never see or change the key.
   */
  async listModelsForBusiness(businessId: string): Promise<LlmModelOption[]> {
    const row = await this.getRow(businessId);
    if (!row?.apiKeyCipher || !isEncryptionConfigured()) return [];
    return PROVIDER_MODELS[row.provider as AiProviderId] ?? [];
  }

  /** Bumps the usage counter, rolling it over at the start of a new month. */
  async recordUsage(
    businessId: string,
    spent?: {input: number; output: number; model: string},
  ): Promise<void> {
    const period = this.currentPeriod();
    const row = await this.getRow(businessId);
    if (!row) return;

    // Priced with the model that actually ran, not the one currently saved —
    // an owner comparing models mid-month would otherwise see every earlier
    // question silently repriced.
    //
    // No stored key means the tokens came out of Pimpo's account, so the shop
    // is quoted list price plus SYSTEM_TOKEN_MARKUP. Today that branch is never
    // taken (resolveProvider refuses without a key), but the accounting is the
    // part that has to be right the day a Pimpo-supplied key ships — see
    // SHIP.md's follow-ups.
    const systemKey = !row.apiKeyCipher;
    const cost = spent
      ? estimateCostUsd(
          spent.model,
          row.provider as AiProviderId,
          spent.input,
          spent.output,
          systemKey,
        )
      : 0;

    // A new month starts the counters from this question rather than adding to
    // last month's totals.
    const fresh = row.monthlyPeriod !== period;
    await this.db
      .update(aiSettings)
      .set({
        monthlyPeriod: period,
        monthlyCount: fresh ? 1 : row.monthlyCount + 1,
        monthlyInputTokens:
          (fresh ? 0 : row.monthlyInputTokens) + (spent?.input ?? 0),
        monthlyOutputTokens:
          (fresh ? 0 : row.monthlyOutputTokens) + (spent?.output ?? 0),
        monthlyCostUsd: (fresh ? 0 : row.monthlyCostUsd) + cost,
        lastUsedAt: new Date(),
      })
      .where(eq(aiSettings.businessId, businessId));
  }
}
