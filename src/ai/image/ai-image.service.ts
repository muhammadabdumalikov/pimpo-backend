import {CACHE_MANAGER} from '@nestjs/cache-manager';
import {Inject, Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {Cache} from 'cache-manager';
import {and, desc, eq, gte, isNotNull, isNull, lt, sql} from 'drizzle-orm';
import {CacheKeys, TTL} from '../../cache/cache.util';
import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import {DatabaseService} from '../../database/database.service';
import {
  aiImageGenerations,
  aiImageQuotas,
  businesses,
  products,
} from '../../database/schema';
import {StorageService} from '../../storage/storage.service';
import {TelegramSenderService} from '../../telegram/telegram-sender.service';
import {IAccount} from '../../business/types';
import {generateId} from '../../utils/uuid';
import {estimateCostUsd} from '../providers/llm-provider.interface';
import {
  AI_IMAGE_DEFAULT_BUDGET_USD,
  AI_IMAGE_DEFAULT_LIMIT_USD,
  AiImageUsageView,
  DEFAULT_DESCRIBE_MODEL,
  DEFAULT_IMAGE_MODEL,
  allowanceUsd,
  crossedBudgetThreshold,
  imageCallCostUsd,
  periodEnd,
  periodOf,
  periodStart,
  usageView,
} from './ai-image.pricing';
import {GeminiImageClient, parseThinkingLevel} from './gemini-image.client';
import {
  SourcePhoto,
  prepareInputPhoto,
  sharp,
  toPackshotWebp,
} from './packshot-image';
import {
  DESCRIBE_SYSTEM_PROMPT,
  cleanDescription,
  describeInstruction,
  photoPackshotPrompt,
  textPackshotPrompt,
} from './packshot-prompt';

/** Pictures one shop may make per hour — a stuck button, not a real user. */
const IMAGES_PER_HOUR = 30;
/** Describe calls per hour; cheap, but each still spends our key. */
const DESCRIBES_PER_HOUR = 60;
/** Wall-clock budget of one image call (Pro-class models take ~20s). */
const IMAGE_BUDGET_MS = 90_000;
const DESCRIBE_BUDGET_MS = 30_000;
/** An image nobody saved on a product is removed from S3 after this. */
const UNCLAIMED_AFTER_DAYS = 7;
/** Largest source image accepted (upload or one of our S3 objects). */
export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/** Finish/block reasons that mean "the model said no", not "it broke". */
const REFUSAL_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
  'OTHER', // promptFeedback.blockReason OTHER
]);

export type {SourcePhoto} from './packshot-image';

export interface DescribeInput {
  name: string;
  brand?: string;
  category?: string;
  unit?: string;
}

export interface GeneratedImage {
  id: string;
  /** The packshot WebP — sent to the client as is; not in S3 until attach(). */
  image: Buffer;
  mode: 'photo' | 'text';
  usage: AiImageUsageView;
}

export interface AiImageQuotaView {
  period: string;
  defaultLimitUsd: number;
  /** The console's override; null = the default applies. */
  monthlyLimitUsd: number | null;
  /** Bonus granted for THIS month (0 when none). */
  bonusUsd: number;
  allowanceUsd: number;
  spentUsd: number;
  imageCount: number;
  usage: AiImageUsageView;
}

/**
 * AI product packshots on Pimpo's own Gemini key (AI-RASM.md).
 *
 * Money first: before any paid call the shop's monthly allowance and the
 * platform budget are checked, and every call that reached Google — refused
 * ones included — is written to ai_image_generations with what it cost. The
 * allowance and the budget are sums over that table, so there is no counter to
 * drift out of step with the ledger.
 */
@Injectable()
export class AiImageService {
  private readonly logger = new Logger(AiImageService.name);
  /** undefined = not built yet; null = no key on this server. */
  private client: GeminiImageClient | null | undefined;

  constructor(
    private readonly dbService: DatabaseService,
    private readonly storage: StorageService,
    private readonly telegram: TelegramSenderService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ── Config (read per call: an env change applies on the next request) ───

  private get imageModel(): string {
    return process.env.GEMINI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
  }

  private get describeModel(): string {
    return process.env.GEMINI_DESCRIBE_MODEL?.trim() || DEFAULT_DESCRIBE_MODEL;
  }

  private get budgetUsd(): number {
    const raw = Number(process.env.AI_IMAGE_MONTHLY_BUDGET_USD);
    return Number.isFinite(raw) && raw > 0 ? raw : AI_IMAGE_DEFAULT_BUDGET_USD;
  }

  /** Test seam: the specs hand in a stub client. */
  setClientForTesting(client: GeminiImageClient | null): void {
    this.client = client;
  }

  private getClient(): GeminiImageClient {
    if (this.client === undefined) {
      const key = process.env.GEMINI_API_KEY?.trim();
      this.client = key ? GeminiImageClient.fromKey(key) : null;
    }
    if (!this.client) throw new AppException(ErrorCode.AI_IMAGE_NOT_CONFIGURED);
    return this.client;
  }

  // ── What the shop sees ───────────────────────────────────────────────────

  async usage(businessId: string): Promise<AiImageUsageView> {
    const period = periodOf(new Date());
    const [spent, quota] = await Promise.all([
      this.spentUsd(period, businessId),
      this.quotaRow(businessId),
    ]);
    return usageView(
      spent,
      allowanceUsd(quota, period),
      this.imageModel,
      period,
    );
  }

  /** Step 1 (Q4): an English packaging description the shop then edits. */
  async describe(
    account: IAccount,
    input: DescribeInput,
    source: SourcePhoto | null,
  ): Promise<{description: string}> {
    const businessId = account.businessId;
    const client = this.getClient();
    await this.assertCanSpend(businessId);
    await this.countHourly(businessId, 'describe', DESCRIBES_PER_HOUR);

    const photo = source ? await prepareInputPhoto(source) : undefined;
    const mode = photo ? 'photo' : 'text';
    const model = this.describeModel;

    let result: Awaited<ReturnType<GeminiImageClient['describe']>>;
    try {
      result = await withBudget(DESCRIBE_BUDGET_MS, (signal) =>
        client.describe({
          model,
          system: DESCRIBE_SYSTEM_PROMPT,
          instruction: describeInstruction({...input, hasPhoto: !!photo}),
          photo,
          signal,
        }),
      );
    } catch (err) {
      throw this.toAppException(err);
    }

    const description = cleanDescription(result.text) || input.name.trim();
    await this.record({
      businessId,
      accountId: account.id,
      productId: null,
      kind: 'describe',
      mode,
      model,
      description,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: estimateCostUsd(
        model,
        'gemini',
        result.inputTokens,
        result.outputTokens,
      ),
      status: 'ok',
    });
    return {description};
  }

  /** Step 2: the packshot itself, stored and returned for the shop to accept. */
  async generate(
    account: IAccount,
    input: {description: string; productId?: string},
    source: SourcePhoto | null,
  ): Promise<GeneratedImage> {
    const businessId = account.businessId;
    const description = cleanDescription(input.description);
    if (!description) throw new AppException(ErrorCode.VALIDATION_ERROR);

    const client = this.getClient();
    const platformBefore = await this.assertCanSpend(businessId);
    const productId = await this.ownProductId(businessId, input.productId);
    await this.lock(businessId);
    try {
      await this.countHourly(businessId, 'image', IMAGES_PER_HOUR);
      const photo = source ? await prepareInputPhoto(source) : undefined;
      const mode: 'photo' | 'text' = photo ? 'photo' : 'text';
      const model = this.imageModel;
      const prompt = photo
        ? photoPackshotPrompt(description)
        : textPackshotPrompt(description);

      let result: Awaited<ReturnType<GeminiImageClient['generate']>>;
      try {
        result = await withBudget(IMAGE_BUDGET_MS, (signal) =>
          client.generate({
            model,
            prompt,
            photo,
            thinkingLevel: parseThinkingLevel(
              process.env.GEMINI_IMAGE_THINKING,
            ),
            signal,
          }),
        );
      } catch (err) {
        throw this.toAppException(err);
      }

      const costUsd = imageCallCostUsd(model, result.usage);
      const base = {
        businessId,
        accountId: account.id,
        productId,
        kind: 'image' as const,
        mode,
        model,
        description,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.imageTokens + result.usage.textTokens,
        costUsd,
      };
      // Whatever happens next, Google has billed this call.
      void this.maybeAlertBudget(platformBefore, platformBefore + costUsd);

      if (!result.image) {
        const reason = result.blockReason ?? result.finishReason ?? 'NO_IMAGE';
        await this.record({...base, status: 'failed', failReason: reason});
        this.logger.warn(
          `AI image for ${businessId} came back without a picture: ${reason}`,
        );
        throw new AppException(
          REFUSAL_REASONS.has(reason)
            ? ErrorCode.AI_IMAGE_REFUSED
            : ErrorCode.AI_IMAGE_FAILED,
        );
      }

      // Not stored anywhere: the shop first looks at it, and only a picture
      // that ends up on a saved product goes to S3 — the browser holds the
      // bytes meanwhile and hands them to attach() when the product is saved.
      const id = generateId();
      let webp: Buffer;
      try {
        webp = await toPackshotWebp(result.image);
      } catch (err) {
        await this.record({...base, status: 'failed', failReason: 'ENCODE'});
        this.logger.error(
          `AI image for ${businessId} could not be encoded: ${(err as Error)?.message}`,
        );
        throw new AppException(ErrorCode.AI_IMAGE_FAILED);
      }

      await this.record({...base, id, status: 'ok'});
      return {
        id,
        image: webp,
        mode,
        usage: await this.usage(businessId),
      };
    } finally {
      await this.unlock(businessId);
    }
  }

  /**
   * Puts a generated packshot in S3 — called when the product it was accepted
   * for is being saved, with the bytes the browser was given. Idempotent: a
   * second call (a save retried after an error) returns the URL the first
   * one stored.
   */
  async attach(
    account: IAccount,
    id: string,
    image: Buffer,
  ): Promise<{url: string}> {
    const businessId = account.businessId;
    const [row] = await this.db
      .select({
        imageUrl: aiImageGenerations.imageUrl,
        purgedAt: aiImageGenerations.purgedAt,
      })
      .from(aiImageGenerations)
      .where(
        and(
          eq(aiImageGenerations.id, id),
          eq(aiImageGenerations.businessId, businessId),
          eq(aiImageGenerations.kind, 'image'),
          eq(aiImageGenerations.status, 'ok'),
        ),
      )
      .limit(1);
    if (!row) throw new AppException(ErrorCode.AI_IMAGE_EXPIRED);
    // Only ever a WebP we sent: anything else is a client bug, not a picture.
    const meta = await sharp(image)
      .metadata()
      .catch(() => null);
    if (meta?.format !== 'webp' || (meta.width ?? 0) > 2048) {
      throw new AppException(ErrorCode.INVALID_FILE_TYPE, {
        allowed: 'image/webp',
      });
    }
    if (row.imageUrl && !row.purgedAt) return {url: row.imageUrl};

    let stored: {url: string; key: string};
    try {
      stored = await this.storage.upload(image, {
        key: `products/ai/${businessId}/${id}.webp`,
        contentType: 'image/webp',
      });
    } catch (err) {
      this.logger.error(
        `AI image ${id} could not be stored: ${(err as Error)?.message}`,
      );
      throw new AppException(ErrorCode.AI_IMAGE_FAILED);
    }
    await this.db
      .update(aiImageGenerations)
      .set({imageKey: stored.key, imageUrl: stored.url, purgedAt: null})
      .where(eq(aiImageGenerations.id, id));
    return {url: stored.url};
  }

  /**
   * The bytes of one of OUR images (a product's current picture), so "improve
   * this image" needs no re-upload. Any other URL is refused: the server never
   * fetches an address a client chose.
   */
  async sourceFromOwnUrl(url: string): Promise<SourcePhoto> {
    const key = this.storage.keyFromUrl(url);
    const object = key
      ? await this.storage.download(key, MAX_SOURCE_BYTES)
      : null;
    if (!object) throw new AppException(ErrorCode.AI_IMAGE_PHOTO_UNREADABLE);
    return {
      data: object.data,
      mimeType: object.contentType ?? 'application/octet-stream',
    };
  }

  // ── Platform console ─────────────────────────────────────────────────────

  async platformSummary() {
    const period = periodOf(new Date());
    const from = periodStart(period);
    const to = periodEnd(period);
    const inMonth = and(
      gte(aiImageGenerations.createdAt, from),
      lt(aiImageGenerations.createdAt, to),
    );

    const [totals] = await this.db
      .select({
        spentUsd: sql<number>`coalesce(sum(${aiImageGenerations.costUsd}), 0)`,
        images: sql<number>`count(*) filter (where ${aiImageGenerations.kind} = 'image' and ${aiImageGenerations.status} = 'ok')`,
        failed: sql<number>`count(*) filter (where ${aiImageGenerations.kind} = 'image' and ${aiImageGenerations.status} = 'failed')`,
        accepted: sql<number>`count(*) filter (where ${aiImageGenerations.acceptedAt} is not null)`,
        photoImages: sql<number>`count(*) filter (where ${aiImageGenerations.kind} = 'image' and ${aiImageGenerations.status} = 'ok' and ${aiImageGenerations.mode} = 'photo')`,
      })
      .from(aiImageGenerations)
      .where(inMonth);

    const spentExpr = sql<number>`coalesce(sum(${aiImageGenerations.costUsd}), 0)`;
    const top = await this.db
      .select({
        businessId: aiImageGenerations.businessId,
        name: businesses.name,
        spentUsd: spentExpr,
        images: sql<number>`count(*) filter (where ${aiImageGenerations.kind} = 'image' and ${aiImageGenerations.status} = 'ok')`,
      })
      .from(aiImageGenerations)
      .innerJoin(businesses, eq(businesses.id, aiImageGenerations.businessId))
      .where(inMonth)
      .groupBy(aiImageGenerations.businessId, businesses.name)
      .orderBy(desc(spentExpr))
      .limit(20);

    return {
      period,
      configured: !!process.env.GEMINI_API_KEY?.trim(),
      model: this.imageModel,
      budgetUsd: this.budgetUsd,
      defaultLimitUsd: AI_IMAGE_DEFAULT_LIMIT_USD,
      spentUsd: round4(Number(totals?.spentUsd ?? 0)),
      imageCount: Number(totals?.images ?? 0),
      photoImageCount: Number(totals?.photoImages ?? 0),
      failedCount: Number(totals?.failed ?? 0),
      acceptedCount: Number(totals?.accepted ?? 0),
      topBusinesses: top.map((r) => ({
        businessId: r.businessId,
        name: r.name,
        spentUsd: round4(Number(r.spentUsd)),
        imageCount: Number(r.images),
      })),
    };
  }

  async getQuota(businessId: string): Promise<AiImageQuotaView> {
    await this.assertBusiness(businessId);
    const period = periodOf(new Date());
    const [quota, spent, images] = await Promise.all([
      this.quotaRow(businessId),
      this.spentUsd(period, businessId),
      this.imageCount(period, businessId),
    ]);
    const allowance = allowanceUsd(quota, period);
    return {
      period,
      defaultLimitUsd: AI_IMAGE_DEFAULT_LIMIT_USD,
      monthlyLimitUsd: quota?.monthlyLimitUsd ?? null,
      bonusUsd: quota && quota.bonusPeriod === period ? quota.bonusUsd : 0,
      allowanceUsd: allowance,
      spentUsd: round4(spent),
      imageCount: images,
      usage: usageView(spent, allowance, this.imageModel, period),
    };
  }

  /**
   * `monthlyLimitUsd`: a number sets the allowance, null returns it to the
   * default, absent leaves it. `bonusUsd`: a top-up for the CURRENT month
   * only (0 clears it), absent leaves it.
   */
  async setQuota(
    businessId: string,
    dto: {monthlyLimitUsd?: number | null; bonusUsd?: number},
  ): Promise<AiImageQuotaView> {
    await this.assertBusiness(businessId);
    const current = await this.quotaRow(businessId);
    const period = periodOf(new Date());
    const next = {
      monthlyLimitUsd:
        dto.monthlyLimitUsd === undefined
          ? (current?.monthlyLimitUsd ?? null)
          : dto.monthlyLimitUsd,
      bonusUsd:
        dto.bonusUsd === undefined ? (current?.bonusUsd ?? 0) : dto.bonusUsd,
      bonusPeriod:
        dto.bonusUsd === undefined ? (current?.bonusPeriod ?? null) : period,
      updatedAt: new Date(),
    };
    await this.db
      .insert(aiImageQuotas)
      .values({businessId, ...next})
      .onConflictDoUpdate({target: aiImageQuotas.businessId, set: next});
    return this.getQuota(businessId);
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────

  /**
   * Removes packshots nobody put on a product. The ledger row stays (it is
   * the spend history) and is stamped `purged_at`. An image a product does use
   * but that was never claimed — saved by a path that does not claim — is
   * claimed here instead of deleted.
   */
  @Cron('45 4 * * *', {name: 'ai-image-sweep', timeZone: 'Asia/Tashkent'})
  async sweepUnclaimed(): Promise<void> {
    const cutoff = new Date(Date.now() - UNCLAIMED_AFTER_DAYS * 86_400_000);
    const stale = await this.db
      .select({
        id: aiImageGenerations.id,
        businessId: aiImageGenerations.businessId,
        imageKey: aiImageGenerations.imageKey,
        imageUrl: aiImageGenerations.imageUrl,
      })
      .from(aiImageGenerations)
      .where(
        and(
          eq(aiImageGenerations.kind, 'image'),
          isNull(aiImageGenerations.acceptedAt),
          isNull(aiImageGenerations.purgedAt),
          isNotNull(aiImageGenerations.imageKey),
          lt(aiImageGenerations.createdAt, cutoff),
        ),
      )
      .limit(500);

    let purged = 0;
    for (const row of stale) {
      const [used] = await this.db
        .select({id: products.id})
        .from(products)
        .where(
          and(
            eq(products.businessId, row.businessId),
            eq(products.image, row.imageUrl!),
          ),
        )
        .limit(1);
      if (used) {
        await this.db
          .update(aiImageGenerations)
          .set({acceptedAt: new Date(), productId: used.id})
          .where(eq(aiImageGenerations.id, row.id));
        continue;
      }
      try {
        await this.storage.delete(row.imageKey!);
      } catch (err) {
        this.logger.warn(
          `AI image sweep could not delete ${row.imageKey}: ${(err as Error)?.message}`,
        );
        continue;
      }
      await this.db
        .update(aiImageGenerations)
        .set({purgedAt: new Date()})
        .where(eq(aiImageGenerations.id, row.id));
      purged++;
    }
    if (purged > 0) this.logger.log(`Swept ${purged} unclaimed AI image(s)`);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Refuses a call the shop's allowance or the platform budget cannot cover.
   * Returns the platform's spend so far, for the budget alert afterwards.
   */
  private async assertCanSpend(businessId: string): Promise<number> {
    const period = periodOf(new Date());
    const [spent, quota, platform] = await Promise.all([
      this.spentUsd(period, businessId),
      this.quotaRow(businessId),
      this.spentUsd(period),
    ]);
    if (spent >= allowanceUsd(quota, period)) {
      throw new AppException(ErrorCode.AI_IMAGE_LIMIT_REACHED, {
        resetsAt: `${periodOf(periodEnd(period))}-01`,
      });
    }
    if (platform >= this.budgetUsd) {
      this.logger.error(
        `AI image budget exhausted: $${platform.toFixed(2)} of $${this.budgetUsd}`,
      );
      throw new AppException(ErrorCode.AI_IMAGE_BUDGET_EXHAUSTED);
    }
    return platform;
  }

  /** USD spent in `period` — by one shop, or by everyone when none is given. */
  private async spentUsd(period: string, businessId?: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${aiImageGenerations.costUsd}), 0)`,
      })
      .from(aiImageGenerations)
      .where(
        and(
          businessId
            ? eq(aiImageGenerations.businessId, businessId)
            : undefined,
          gte(aiImageGenerations.createdAt, periodStart(period)),
          lt(aiImageGenerations.createdAt, periodEnd(period)),
        ),
      );
    return Number(row?.total ?? 0);
  }

  private async imageCount(
    period: string,
    businessId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({n: sql<number>`count(*)`})
      .from(aiImageGenerations)
      .where(
        and(
          eq(aiImageGenerations.businessId, businessId),
          eq(aiImageGenerations.kind, 'image'),
          eq(aiImageGenerations.status, 'ok'),
          gte(aiImageGenerations.createdAt, periodStart(period)),
          lt(aiImageGenerations.createdAt, periodEnd(period)),
        ),
      );
    return Number(row?.n ?? 0);
  }

  private async quotaRow(businessId: string) {
    const [row] = await this.db
      .select()
      .from(aiImageQuotas)
      .where(eq(aiImageQuotas.businessId, businessId))
      .limit(1);
    return row ?? null;
  }

  private async assertBusiness(businessId: string): Promise<void> {
    const [row] = await this.db
      .select({id: businesses.id})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
  }

  /** The productId only if it is this shop's card — it lands in the ledger. */
  private async ownProductId(
    businessId: string,
    productId: string | undefined,
  ): Promise<string | null> {
    if (!productId) return null;
    const [row] = await this.db
      .select({id: products.id})
      .from(products)
      .where(
        and(eq(products.id, productId), eq(products.businessId, businessId)),
      )
      .limit(1);
    return row?.id ?? null;
  }

  private async record(row: {
    id?: string;
    businessId: string;
    accountId: string;
    productId: string | null;
    kind: 'describe' | 'image';
    mode: 'photo' | 'text';
    model: string;
    description: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    status: 'ok' | 'failed';
    failReason?: string;
    imageKey?: string;
    imageUrl?: string;
  }): Promise<void> {
    await this.db.insert(aiImageGenerations).values({
      ...row,
      id: row.id ?? generateId(),
      failReason: row.failReason?.slice(0, 40) ?? null,
      createdAt: new Date(),
    });
  }

  /** Fixed-window hourly counter, the same shape as the assistant's. */
  private async countHourly(
    businessId: string,
    step: 'describe' | 'image',
    limit: number,
  ): Promise<void> {
    const bucket = new Date().toISOString().slice(0, 13);
    const key = CacheKeys.aiImageRate(businessId, step, bucket);
    const used = (await this.cache.get<number>(key)) ?? 0;
    if (used >= limit) throw new AppException(ErrorCode.AI_IMAGE_RATE_LIMITED);
    await this.cache.set(key, used + 1, TTL.AI_RATE);
  }

  /**
   * One picture at a time per shop. Not an atomic lock — two requests in the
   * same millisecond can both pass — but what it stops is a person tapping
   * "Qayta yaratish" while the first one is still running, and the hourly
   * counter bounds the rest.
   */
  private async lock(businessId: string): Promise<void> {
    const key = CacheKeys.aiImageBusy(businessId);
    if (await this.cache.get(key))
      throw new AppException(ErrorCode.AI_IMAGE_BUSY);
    await this.cache.set(key, 1, TTL.AI_IMAGE_BUSY);
  }

  private async unlock(businessId: string): Promise<void> {
    try {
      await this.cache.del(CacheKeys.aiImageBusy(businessId));
    } catch {
      // The TTL frees it anyway.
    }
  }

  /** Telegram to the platform owner at 80% and 100% of the monthly budget. */
  private async maybeAlertBudget(before: number, after: number): Promise<void> {
    try {
      const budget = this.budgetUsd;
      const pct = crossedBudgetThreshold(before, after, budget);
      if (!pct) return;
      const period = periodOf(new Date());
      const key = CacheKeys.aiImageAlert(period, pct);
      if (await this.cache.get(key)) return;
      await this.cache.set(key, 1, TTL.AI_IMAGE_ALERT);

      const text =
        `⚠️ AI rasm budjeti: ${pct}% (${period})\n` +
        `Sarflandi: $${after.toFixed(2)} / $${budget}\n` +
        (pct >= 100
          ? "Generatsiya hamma do'konda to'xtadi. AI_IMAGE_MONTHLY_BUDGET_USD ni oshiring yoki oy almashishini kuting."
          : "Platforma konsolida kim ko'p sarflayotganini ko'ring.");
      this.logger.warn(text.replace(/\n/g, ' · '));

      const chatId = process.env.PLATFORM_ALERT_CHAT_ID?.trim();
      if (chatId && this.telegram.isConfigured()) {
        await this.telegram.sendMessage(chatId, text);
      }
    } catch (err) {
      this.logger.warn(
        `AI image budget alert failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** SDK errors → our codes. The shop can fix none of these, so no detail. */
  private toAppException(err: unknown): AppException {
    if (err instanceof AppException) return err;
    if (
      (err as Error)?.name === 'AbortError' ||
      err instanceof BudgetExceeded
    ) {
      return new AppException(ErrorCode.AI_IMAGE_TIMEOUT);
    }
    const status =
      (err as {status?: number})?.status ??
      (err as {statusCode?: number})?.statusCode;
    const message = (err as Error)?.message ?? String(err);
    if (status === 401 || status === 403 || status === 404) {
      // Our key was rejected or the model id is wrong — an ops problem.
      this.logger.error(
        `Gemini rejected the platform image call (${status}): ${message}`,
      );
      return new AppException(ErrorCode.AI_IMAGE_NOT_CONFIGURED);
    }
    if (status === 429) {
      // Google's per-project limits (Tier 1: $10 per 10 min, $250 a month).
      this.logger.error(`Gemini rate/spend limit hit: ${message}`);
      return new AppException(ErrorCode.AI_IMAGE_BUDGET_EXHAUSTED);
    }
    this.logger.warn(`Gemini image call failed: ${message}`);
    return new AppException(ErrorCode.AI_PROVIDER_UNAVAILABLE);
  }
}

class BudgetExceeded extends Error {}

/** Runs `fn` with an abort signal that fires after `ms`. */
async function withBudget<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) throw new BudgetExceeded('timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
