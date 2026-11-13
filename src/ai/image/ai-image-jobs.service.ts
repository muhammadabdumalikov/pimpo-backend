import {Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {and, eq, inArray, isNull, or, sql} from 'drizzle-orm';
import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import {DatabaseService} from '../../database/database.service';
import {
  aiImageGenerations,
  aiImageJobs,
  brands,
  businesses,
  categories,
  globalBarcodes,
  products,
  units,
} from '../../database/schema';
import {generateId} from '../../utils/uuid';
import {AiImageService} from './ai-image.service';

/** Most pictures one console order may queue. */
export const MAX_JOBS_PER_ORDER = 100;
/** A job still 'running' this long after its last touch died with its process. */
const STUCK_AFTER_MS = 5 * 60_000;
/** A job that died this many times stops being retried by itself. */
const MAX_ATTEMPTS = 3;
/** Errors that will hit every queued job alike: stop the queue, don't burn it. */
const QUEUE_STOPPERS = new Set<ErrorCode>([
  ErrorCode.AI_IMAGE_BUDGET_EXHAUSTED,
  ErrorCode.AI_IMAGE_NOT_CONFIGURED,
]);

export type AiImageJobStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'applied'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface AiImageCandidate {
  productId: string;
  name: string;
  barcode: string | null;
  /** Completed receipts the product was on in the window. */
  receipts: number;
  quantity: number;
  /** The shared catalogue already has a picture for this barcode: free. */
  globalImage: string | null;
  /** The newest console job for this product, if any. */
  job: {
    id: string;
    status: AiImageJobStatus;
    imageUrl: string | null;
    description: string | null;
    failReason: string | null;
  } | null;
}

/**
 * Pictures the platform console orders for a shop's best sellers that have
 * none (AI-RASM.md "Platformadan ommaviy").
 *
 * The console sees the shop's top sellers without a picture; those whose
 * barcode already has a shared picture get it for free, the rest are queued
 * here. A cron drains the queue one picture at a time — text-mode packshots on
 * the platform's budget (AiImageService.makeForPlatform) — and leaves each one
 * 'ready' in S3. Nothing reaches a card until the console approves it; a
 * rejected or never-decided picture is swept with the other unclaimed ones.
 */
@Injectable()
export class AiImageJobsService {
  private readonly logger = new Logger(AiImageJobsService.name);
  private draining = false;

  constructor(
    private readonly dbService: DatabaseService,
    private readonly images: AiImageService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ── Console reads ────────────────────────────────────────────────────────

  async candidates(businessId: string, days: number, limit: number) {
    await this.assertBusiness(businessId);
    const rows = (await this.db.execute(sql`
      WITH sales AS (
        SELECT oi.product_id,
               count(DISTINCT oi.order_id)::int AS receipts,
               coalesce(sum(oi.quantity), 0)::float8 AS quantity
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.business_id = ${businessId}
          AND o.business_id = ${businessId}
          AND o.status = 'Completed'
          AND o.created_at >= now() - make_interval(days => ${days}::int)
          AND oi.product_id IS NOT NULL
        GROUP BY oi.product_id
      )
      SELECT p.id AS product_id, p.name, p.barcode,
             s.receipts, s.quantity,
             g.image AS global_image,
             j.id AS job_id, j.status AS job_status, j.image_url AS job_image,
             j.description AS job_description, j.fail_reason AS job_fail
      FROM sales s
      JOIN products p
        ON p.id = s.product_id AND p.business_id = ${businessId}
       AND p.is_active AND coalesce(p.image, '') = ''
      LEFT JOIN global_barcodes g
        ON g.barcode = p.barcode AND coalesce(g.image, '') <> ''
      LEFT JOIN LATERAL (
        SELECT * FROM ai_image_jobs j
        WHERE j.business_id = ${businessId} AND j.product_id = p.id
        ORDER BY j.created_at DESC
        LIMIT 1
      ) j ON true
      ORDER BY s.receipts DESC, s.quantity DESC, p.name
      LIMIT ${limit}
    `)) as unknown as Array<{
      product_id: string;
      name: string;
      barcode: string | null;
      receipts: number;
      quantity: number;
      global_image: string | null;
      job_id: string | null;
      job_status: AiImageJobStatus | null;
      job_image: string | null;
      job_description: string | null;
      job_fail: string | null;
    }>;

    const items: AiImageCandidate[] = rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      barcode: r.barcode,
      receipts: Number(r.receipts),
      quantity: Number(r.quantity),
      globalImage: r.global_image,
      job: r.job_id
        ? {
            id: r.job_id,
            status: r.job_status!,
            imageUrl: r.job_image,
            description: r.job_description,
            failReason: r.job_fail,
          }
        : null,
    }));

    const [queue] = await this.db
      .select({
        queued: sql<number>`count(*) filter (where ${aiImageJobs.status} in ('queued', 'running'))::int`,
        ready: sql<number>`count(*) filter (where ${aiImageJobs.status} = 'ready')::int`,
      })
      .from(aiImageJobs)
      .where(eq(aiImageJobs.businessId, businessId));

    return {
      configured: this.images.isConfigured(),
      costPerImageUsd: this.images.typicalCostUsd(),
      budget: await this.images.platformBudget(),
      queued: Number(queue?.queued ?? 0),
      ready: Number(queue?.ready ?? 0),
      items,
    };
  }

  // ── Console writes ───────────────────────────────────────────────────────

  /**
   * Queues a picture for each of these products that still has none, has no
   * shared picture to take for free, and has no job under way or waiting.
   */
  async enqueue(businessId: string, productIds: string[]) {
    await this.assertBusiness(businessId);
    if (!this.images.isConfigured()) {
      throw new AppException(ErrorCode.AI_IMAGE_NOT_CONFIGURED);
    }
    const ids = [...new Set(productIds)].slice(0, MAX_JOBS_PER_ORDER);
    if (ids.length === 0) return {queued: 0, skipped: 0};
    const budget = await this.images.platformBudget();
    if (budget.spentUsd >= budget.budgetUsd) {
      throw new AppException(ErrorCode.AI_IMAGE_BUDGET_EXHAUSTED);
    }

    const eligible = await this.db
      .select({id: products.id})
      .from(products)
      .leftJoin(
        globalBarcodes,
        and(
          eq(globalBarcodes.barcode, products.barcode),
          sql`coalesce(${globalBarcodes.image}, '') <> ''`,
        ),
      )
      .where(
        and(
          eq(products.businessId, businessId),
          inArray(products.id, ids),
          eq(products.isActive, true),
          or(isNull(products.image), eq(products.image, '')),
          isNull(globalBarcodes.barcode),
          sql`NOT EXISTS (
            SELECT 1 FROM ai_image_jobs j
            WHERE j.business_id = ${businessId} AND j.product_id = ${products.id}
              AND j.status IN ('queued', 'running', 'ready')
          )`,
        ),
      );

    if (eligible.length > 0) {
      const now = new Date();
      await this.db.insert(aiImageJobs).values(
        eligible.map((p) => ({
          id: generateId(),
          businessId,
          productId: p.id,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        })),
      );
      // Start now rather than on the next cron tick.
      setImmediate(() => void this.drain());
    }
    return {queued: eligible.length, skipped: ids.length - eligible.length};
  }

  /**
   * Puts the shared catalogue's picture on these cards — free, no AI. Only on
   * cards still without a picture; the card then follows the shared picture
   * like any card the barcode lookup filled (GlobalBarcodeService).
   */
  async applyGlobal(businessId: string, productIds: string[]) {
    await this.assertBusiness(businessId);
    const ids = [...new Set(productIds)].slice(0, 500);
    if (ids.length === 0) return {applied: 0};
    const moved = await this.db.execute(sql`
      UPDATE products p
      SET image = g.image, updated_at = now()
      FROM global_barcodes g
      WHERE p.business_id = ${businessId}
        AND p.id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND coalesce(p.image, '') = ''
        AND g.barcode = p.barcode
        AND coalesce(g.image, '') <> ''
      RETURNING p.id
    `);
    const applied = (moved as unknown as unknown[]).length;
    this.logger.log(
      `Shared pictures put on ${applied} card(s) of ${businessId} from the console`,
    );
    return {applied};
  }

  /**
   * Puts each ready picture on its card — unless the shop gave the card a
   * picture of its own meanwhile, which is kept (the job is then 'cancelled').
   */
  async approve(businessId: string, jobIds: string[]) {
    const jobs = await this.jobsIn(businessId, jobIds, ['ready']);
    let applied = 0;
    let kept = 0;
    for (const job of jobs) {
      const done = await this.db.transaction(async (tx) => {
        const moved = await tx
          .update(products)
          .set({image: job.imageUrl, updatedAt: new Date()})
          .where(
            and(
              eq(products.id, job.productId),
              eq(products.businessId, businessId),
              or(isNull(products.image), eq(products.image, '')),
            ),
          )
          .returning({id: products.id});
        const ok = moved.length > 0;
        await tx
          .update(aiImageJobs)
          .set({
            status: ok ? 'applied' : 'cancelled',
            failReason: ok ? null : 'HAS_IMAGE',
            decidedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(aiImageJobs.id, job.id));
        if (ok && job.generationId) {
          // Claimed like a shop-saved packshot, so the sweep keeps it.
          await tx
            .update(aiImageGenerations)
            .set({acceptedAt: new Date(), productId: job.productId})
            .where(eq(aiImageGenerations.id, job.generationId));
        }
        return ok;
      });
      if (done) applied++;
      else kept++;
    }
    return {applied, kept};
  }

  async reject(businessId: string, jobIds: string[]) {
    const jobs = await this.jobsIn(businessId, jobIds, ['ready']);
    if (jobs.length === 0) return {rejected: 0};
    await this.db
      .update(aiImageJobs)
      .set({status: 'rejected', decidedAt: new Date(), updatedAt: new Date()})
      .where(
        inArray(
          aiImageJobs.id,
          jobs.map((j) => j.id),
        ),
      );
    return {rejected: jobs.length};
  }

  /** Queues a fresh picture for a rejected, failed or ready job's product. */
  async retry(businessId: string, jobIds: string[]) {
    const jobs = await this.jobsIn(businessId, jobIds, [
      'ready',
      'rejected',
      'failed',
      'cancelled',
    ]);
    if (jobs.length === 0) return {queued: 0, skipped: 0};
    const ready = jobs.filter((j) => j.status === 'ready').map((j) => j.id);
    if (ready.length > 0) {
      await this.db
        .update(aiImageJobs)
        .set({status: 'rejected', decidedAt: new Date(), updatedAt: new Date()})
        .where(inArray(aiImageJobs.id, ready));
    }
    return this.enqueue(
      businessId,
      jobs.map((j) => j.productId),
    );
  }

  /** Drops the pictures not yet started. */
  async cancelQueued(businessId: string) {
    const rows = await this.db
      .update(aiImageJobs)
      .set({status: 'cancelled', updatedAt: new Date()})
      .where(
        and(
          eq(aiImageJobs.businessId, businessId),
          eq(aiImageJobs.status, 'queued'),
        ),
      )
      .returning({id: aiImageJobs.id});
    return {cancelled: rows.length};
  }

  // ── Worker ───────────────────────────────────────────────────────────────

  /**
   * Drains the queue one picture at a time. Safe with several containers: a
   * job is claimed with FOR UPDATE SKIP LOCKED, so two never take the same one.
   */
  @Cron('*/30 * * * * *', {name: 'ai-image-jobs'})
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.reviveStuck();
      for (;;) {
        const job = await this.claimNext();
        if (!job) break;
        const stop = await this.run(job);
        if (stop) break;
      }
    } catch (err) {
      this.logger.error(
        `AI image queue stopped: ${(err as Error)?.message ?? err}`,
      );
    } finally {
      this.draining = false;
    }
  }

  /** Makes one picture. Returns true when the whole queue should stop. */
  private async run(job: typeof aiImageJobs.$inferSelect): Promise<boolean> {
    const [product] = await this.db
      .select({
        name: products.name,
        image: products.image,
        isActive: products.isActive,
        brand: brands.name,
        category: categories.name,
        unit: units.name,
      })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(
        categories,
        and(
          eq(categories.id, products.categoryId),
          eq(categories.businessId, products.businessId),
        ),
      )
      .leftJoin(units, eq(units.id, products.unitId))
      .where(
        and(
          eq(products.id, job.productId),
          eq(products.businessId, job.businessId),
        ),
      )
      .limit(1);

    if (!product || !product.isActive) {
      await this.finish(job.id, {status: 'failed', failReason: 'PRODUCT_GONE'});
      return false;
    }
    if (product.image) {
      await this.finish(job.id, {status: 'cancelled', failReason: 'HAS_IMAGE'});
      return false;
    }

    try {
      const made = await this.images.makeForPlatform(
        job.businessId,
        job.productId,
        {
          name: product.name,
          brand: product.brand ?? undefined,
          category: product.category ?? undefined,
          unit: product.unit ?? undefined,
          description: job.description,
        },
      );
      await this.finish(job.id, {
        status: 'ready',
        generationId: made.generationId,
        imageUrl: made.imageUrl,
        description: made.description,
        failReason: null,
      });
      return false;
    } catch (err) {
      const code =
        err instanceof AppException ? err.code : ErrorCode.AI_IMAGE_FAILED;
      await this.finish(job.id, {status: 'failed', failReason: code});
      if (QUEUE_STOPPERS.has(code)) {
        // Every other queued job would fail the same way: fail them now, so
        // the console shows why and offers "retry" instead of a silent stall.
        await this.db
          .update(aiImageJobs)
          .set({status: 'failed', failReason: code, updatedAt: new Date()})
          .where(eq(aiImageJobs.status, 'queued'));
        this.logger.error(`AI image queue stopped: ${code}`);
        return true;
      }
      this.logger.warn(
        `AI image job ${job.id} (${job.businessId}) failed: ${code}`,
      );
      return false;
    }
  }

  private async claimNext() {
    const rows = (await this.db.execute(sql`
      UPDATE ai_image_jobs
      SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM ai_image_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `)) as unknown as Array<{id: string}>;
    const id = rows[0]?.id;
    if (!id) return null;
    const [job] = await this.db
      .select()
      .from(aiImageJobs)
      .where(eq(aiImageJobs.id, id))
      .limit(1);
    return job ?? null;
  }

  /** A container restart mid-picture leaves a 'running' job behind. */
  private async reviveStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
    await this.db.execute(sql`
      UPDATE ai_image_jobs
      SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
          fail_reason = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'STUCK' ELSE fail_reason END,
          updated_at = now()
      WHERE status = 'running' AND updated_at < ${cutoff}::timestamp
    `);
  }

  private async finish(
    id: string,
    set: Partial<typeof aiImageJobs.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(aiImageJobs)
      .set({...set, updatedAt: new Date()})
      .where(eq(aiImageJobs.id, id));
  }

  private async jobsIn(
    businessId: string,
    jobIds: string[],
    statuses: AiImageJobStatus[],
  ) {
    const ids = [...new Set(jobIds)].slice(0, 500);
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(aiImageJobs)
      .where(
        and(
          eq(aiImageJobs.businessId, businessId),
          inArray(aiImageJobs.id, ids),
          inArray(aiImageJobs.status, statuses),
        ),
      );
  }

  private async assertBusiness(businessId: string): Promise<void> {
    const [row] = await this.db
      .select({id: businesses.id})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
  }
}
