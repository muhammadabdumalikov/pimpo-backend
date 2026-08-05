import {CACHE_MANAGER} from '@nestjs/cache-manager';
import {Inject, Injectable, Logger} from '@nestjs/common';
import {Cache} from 'cache-manager';
import {eq} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {CacheKeys, TTL} from '../cache/cache.util';
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
  lastUsedAt: Date | null;
  /** Catalogue for the model dropdown, so the UI has one source of truth. */
  availableModels: Record<AiProviderId, {id: string; label: string}[]>;
}

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private get db() {
    return this.dbService.db;
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
      monthlyCount:
        row && row.monthlyPeriod === this.currentPeriod()
          ? row.monthlyCount
          : 0,
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
   * Live model catalogue for the settings dropdown.
   *
   * Falls back to the static suggestions rather than failing the page: a key
   * that cannot list models can still perfectly well run one, and the owner
   * should not be blocked from saving because a catalogue call timed out.
   */
  async listModels(
    provider: AiProviderId,
    apiKey: string,
  ): Promise<{models: LlmModelOption[]; live: boolean}> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const models = await createProvider(
        provider,
        apiKey,
        'unused',
      ).listModels(controller.signal);
      if (models.length) return {models, live: true};
    } catch (err) {
      this.logger.warn(
        `Could not list ${provider} models: ${(err as Error)?.message ?? String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    return {models: PROVIDER_MODELS[provider], live: false};
  }

  /**
   * Model catalogue for the chat screen's picker.
   *
   * Cached because this sits on the page-load path and every miss is a provider
   * round trip. Unlike the settings page's version it takes no key argument —
   * it always uses the stored one — so it is safe to expose to staff accounts,
   * who may pick a model but must never see or change the key.
   */
  async listModelsForBusiness(businessId: string): Promise<LlmModelOption[]> {
    const row = await this.getRow(businessId);
    if (!row?.apiKeyCipher || !isEncryptionConfigured()) return [];

    const provider = row.provider as AiProviderId;
    return this.cache.wrap(
      CacheKeys.aiModels(businessId, provider),
      async () => {
        let apiKey: string;
        try {
          apiKey = decryptSecret(row.apiKeyCipher!);
        } catch {
          return PROVIDER_MODELS[provider];
        }
        const {models} = await this.listModels(provider, apiKey);
        return models;
      },
      TTL.AI_MODELS,
    );
  }

  /** Bumps the usage counter, rolling it over at the start of a new month. */
  async recordUsage(businessId: string): Promise<void> {
    const period = this.currentPeriod();
    const row = await this.getRow(businessId);
    if (!row) return;

    await this.db
      .update(aiSettings)
      .set({
        monthlyPeriod: period,
        monthlyCount: row.monthlyPeriod === period ? row.monthlyCount + 1 : 1,
        lastUsedAt: new Date(),
      })
      .where(eq(aiSettings.businessId, businessId));
  }
}
