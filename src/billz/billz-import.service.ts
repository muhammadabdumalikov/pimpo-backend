import {Injectable} from '@nestjs/common';
import {and, count, desc, eq, inArray, lt} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DatabaseService} from '../database/database.service';
import {
  billzImportItems,
  billzImportJobs,
  billzMigrationState,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {BillzImportWorker} from './billz-import.worker';
import {
  initialCounters,
  toItemDto,
  toJobDto,
  type ImportEntity,
  type ImportPhase,
  type ItemDto,
  type JobDto,
} from './billz-import.types';
import {ImportItemsQueryDto} from './dto/import-items-query.dto';

// Statuses that count as an "active" import (only one allowed per business).
const ACTIVE_STATUSES = ['queued', 'running', 'paused'] as const;

@Injectable()
export class BillzImportService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly worker: BillzImportWorker,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** The business's MOST RECENT job (any status), or null if none ever. */
  private async latestJob(businessId: string) {
    const [job] = await this.db
      .select()
      .from(billzImportJobs)
      .where(eq(billzImportJobs.businessId, businessId))
      .orderBy(desc(billzImportJobs.createdAt))
      .limit(1);
    return job ?? null;
  }

  /**
   * Enqueue an import. Requires a verified BiLLZ connection and no already-active
   * job for the business. Wakes the FIFO worker.
   */
  async start(
    businessId: string,
    entities: ImportEntity[],
  ): Promise<{job: JobDto}> {
    const [conn] = await this.db
      .select({verifiedAt: billzMigrationState.verifiedAt})
      .from(billzMigrationState)
      .where(eq(billzMigrationState.businessId, businessId))
      .limit(1);
    if (!conn || !conn.verifiedAt) {
      throw new AppException(ErrorCode.BILLZ_NOT_CONNECTED);
    }

    const [active] = await this.db
      .select({id: billzImportJobs.id})
      .from(billzImportJobs)
      .where(
        and(
          eq(billzImportJobs.businessId, businessId),
          inArray(billzImportJobs.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(1);
    if (active) {
      throw new AppException(ErrorCode.BILLZ_IMPORT_ALREADY_ACTIVE);
    }

    const [job] = await this.db
      .insert(billzImportJobs)
      .values({
        id: generateId(),
        businessId,
        status: 'queued',
        phase: 'fetch',
        entities,
        currentEntity: null,
        counters: initialCounters(entities),
        checkpoint: null,
      })
      .returning();

    this.worker.wake();
    return {job: toJobDto(job)};
  }

  /**
   * Latest job + its position in the queue of the lane it is currently queued in.
   * The importer runs two decoupled lanes (fetch, load), so position/length are
   * PHASE-AWARE: a queued job is ranked only against other queued jobs in the
   * SAME phase, by created_at. queuePosition is 1-based (null unless this job is
   * queued); queueLength is the number of queued jobs in that same lane (falls
   * back to all queued jobs when the business has no job yet).
   */
  async getStatus(businessId: string): Promise<{
    job: JobDto | null;
    queuePosition: number | null;
    queueLength: number;
  }> {
    const job = await this.latestJob(businessId);

    // The lane whose queue we measure: the job's current phase, or (no job yet)
    // all lanes combined so an empty response still reports a sensible length.
    const lane = (job?.phase ?? null) as ImportPhase | null;
    const laneCond = lane
      ? and(
          eq(billzImportJobs.status, 'queued'),
          eq(billzImportJobs.phase, lane),
        )
      : eq(billzImportJobs.status, 'queued');

    const [{value: queueLength}] = await this.db
      .select({value: count()})
      .from(billzImportJobs)
      .where(laneCond);

    let queuePosition: number | null = null;
    if (job && job.status === 'queued') {
      const [{value: ahead}] = await this.db
        .select({value: count()})
        .from(billzImportJobs)
        .where(
          and(
            eq(billzImportJobs.status, 'queued'),
            eq(billzImportJobs.phase, job.phase),
            lt(billzImportJobs.createdAt, job.createdAt),
          ),
        );
      queuePosition = Number(ahead) + 1;
    }

    return {
      job: job ? toJobDto(job) : null,
      queuePosition,
      queueLength: Number(queueLength),
    };
  }

  async pause(businessId: string): Promise<{job: JobDto}> {
    const job = await this.latestJob(businessId);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) {
      throw new AppException(ErrorCode.BILLZ_IMPORT_NOT_ACTIVE);
    }
    const [updated] = await this.db
      .update(billzImportJobs)
      .set({status: 'paused', updatedAt: new Date()})
      .where(eq(billzImportJobs.id, job.id))
      .returning();
    return {job: toJobDto(updated)};
  }

  /**
   * Re-enqueue a paused OR failed job. A failed job resumes from its checkpoint
   * (fetch: the page that failed; load: remaining 'pending' staging rows) — the
   * pages already staged / rows already loaded are never re-done, so a transient
   * BiLLZ outage near the end doesn't force re-pulling the whole catalog.
   */
  async resume(businessId: string): Promise<{job: JobDto}> {
    const job = await this.latestJob(businessId);
    if (!job || (job.status !== 'paused' && job.status !== 'failed')) {
      throw new AppException(ErrorCode.BILLZ_IMPORT_NOT_ACTIVE);
    }
    const [updated] = await this.db
      .update(billzImportJobs)
      .set({
        status: 'queued',
        error: null,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(billzImportJobs.id, job.id))
      .returning();
    this.worker.wake();
    return {job: toJobDto(updated)};
  }

  async cancel(businessId: string): Promise<{job: JobDto}> {
    const job = await this.latestJob(businessId);
    if (
      !job ||
      (job.status !== 'queued' &&
        job.status !== 'running' &&
        job.status !== 'paused')
    ) {
      throw new AppException(ErrorCode.BILLZ_IMPORT_NOT_ACTIVE);
    }
    const now = new Date();
    const [updated] = await this.db
      .update(billzImportJobs)
      .set({status: 'cancelled', finishedAt: now, updatedAt: now})
      .where(eq(billzImportJobs.id, job.id))
      .returning();
    return {job: toJobDto(updated)};
  }

  /**
   * The cumulative per-record log for one entity, across ALL of the business's
   * jobs, newest first. Scoped to business_id.
   */
  async getItems(
    businessId: string,
    query: ImportItemsQueryDto,
  ): Promise<{items: ItemDto[]; total: number; page: number; limit: number}> {
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const rawLimit = parseInt(query.limit ?? '50', 10) || 50;
    const limit = Math.min(100, Math.max(1, rawLimit));
    const status = query.status ?? 'all';

    const conds = [
      eq(billzImportItems.businessId, businessId),
      eq(billzImportItems.entity, query.entity),
    ];
    if (status === 'success' || status === 'failed') {
      conds.push(eq(billzImportItems.status, status));
    }
    const where = and(...conds);

    const [{value: total}] = await this.db
      .select({value: count()})
      .from(billzImportItems)
      .where(where);

    const rows = await this.db
      .select()
      .from(billzImportItems)
      .where(where)
      .orderBy(desc(billzImportItems.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    return {items: rows.map(toItemDto), total: Number(total), page, limit};
  }
}
