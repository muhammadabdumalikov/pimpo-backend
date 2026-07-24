import {Injectable, Logger, OnApplicationBootstrap} from '@nestjs/common';
import {Interval} from '@nestjs/schedule';
import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  type SQL,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {BranchService} from '../branch/branch.service';
import {StorageService} from '../storage/storage.service';
import {setBranchStock} from '../common/branch-stock';
import {generateId} from '../utils/uuid';
import {
  billzImportItems,
  billzImportJobs,
  billzStaging,
  branchStock,
  brands,
  categories,
  inventoryBatches,
  products,
  units,
  users,
  type BillzImportJob,
  type NewBillzImportItem,
  type NewBillzStaging,
  type Unit,
} from '../database/schema';
import {BillzService} from './billz.service';
import {BillzClientService} from './billz-client.service';
import {
  ENTITY_ORDER,
  type EntityCounter,
  type ImportEntity,
  type JobCheckpoint,
  type JobCounters,
} from './billz-import.types';
import {
  asRecord,
  extractList,
  mapCustomer,
  mapProduct,
  str,
} from './billz-mapping';

// Page sizes = the max the API allows (fewer requests → less block risk, §3.1).
const PRODUCTS_LIMIT = 100; // GET /v2/products default/max (MIGRATSIYA §4A.1).
const CUSTOMERS_LIMIT = 50; // GET /v1/client (MIGRATSIYA §4A.3).

// Rows per LOAD-lane batch: one tx applies this many staging rows → real tables.
const LOAD_BATCH = 100;

// Idle poll cadence — one interval kicks BOTH lane drains when idle. Non-overlap.
const IDLE_POLL_MS = 5000;

// Image stage pacing (MIGRATSIYA §3.2 — highest block risk). Sequential, with a
// ≥600ms + 100-300ms jitter gap between CDN downloads (NOT via BillzClient).
const IMAGE_MIN_GAP_MS = 600;
const IMAGE_JITTER_MIN_MS = 100;
const IMAGE_JITTER_MAX_MS = 300;
const IMAGE_TIMEOUT_MS = 10_000;

// ── Small defensive parsing helpers (the BiLLZ API is documented but not yet
// probed — MG2; field names/shapes must be confirmed against real JSON). ──────
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

/** A fresh, all-zero two-dimension counter for one entity. */
function emptyEntityCounter(): EntityCounter {
  return {
    fetch: {total: null, done: 0, failed: 0},
    load: {total: null, done: 0, failed: 0},
  };
}

/** main_image_url, else the photos[] entry flagged is_main (§4A.1). */
function pickMainImage(rec: Record<string, unknown>): string | null {
  const main = (str(rec.main_image_url) ?? '').trim();
  if (main) return main;
  const photos = Array.isArray(rec.photos) ? rec.photos : [];
  for (const p of photos) {
    const ph = asRecord(p);
    if (ph && ph.is_main) {
      const u = (str(ph.photo_url) ?? '').trim();
      if (u) return u;
    }
  }
  return null;
}

// A raw list page harvested by the FETCH lane and turned into staging rows.
interface StagedPage {
  fetched: number; // records the API returned this page (for last-page detection)
  total: number | null; // total the API reports for the entity (fetch.total)
  staged: number; // staging rows written this page (fetch.done delta)
  failed: number; // records skipped: no billz id / unattachable (fetch.failed delta)
  rows: NewBillzStaging[];
}

// The outcome of applying ONE staging row to the real tables (LOAD lane).
interface RowLoad {
  label: string | null;
  ok: boolean;
  error: string | null;
}

/**
 * Two-phase, in-process BiLLZ importer. It runs TWO decoupled, independently
 * guarded loops that share this one worker:
 *
 *  - FETCH lane (global FIFO, one job at a time): pages the rate-limited BiLLZ
 *    API through BillzClientService and writes RAW records into billz_staging.
 *    Stays globally serial because all businesses share the server's one source
 *    IP → one BiLLZ rate-limit budget.
 *  - LOAD lane (independent loop): drains a job's billz_staging rows and maps +
 *    upserts them into the real KPOS tables, writing the billz_import_items audit
 *    rows. Fast internal DB work, no external rate limit.
 *
 * A job flows: (phase='fetch', queued) → fetch lane fills staging → (phase='load',
 * queued) → load lane applies staging → completed. Each page/batch checkpoints +
 * re-reads status, so a job can pause/resume/cancel and survive a crash.
 * MG2 note: all field names/shapes below are defensive and must be confirmed
 * against a real probe.
 */
@Injectable()
export class BillzImportWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillzImportWorker.name);
  // Independent guards so the two lanes never process concurrently WITH THEMSELVES
  // (but fetch and load CAN run at the same time on different jobs).
  private fetchDraining = false;
  private loadDraining = false;
  // Throttle clock for the image-download stage (CDN, not the API).
  private lastImageAt = 0;

  constructor(
    private readonly dbService: DatabaseService,
    private readonly billz: BillzService,
    private readonly client: BillzClientService,
    private readonly branchService: BranchService,
    private readonly storage: StorageService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      // Crash recovery for BOTH lanes: a leftover 'running' job means the process
      // died mid import. Reset it to 'queued' — its phase, checkpoint and staging
      // rows survive, so it resumes exactly where it stopped (a fetch job from its
      // page checkpoint, a load job from the first still-'pending' staging row).
      await this.db
        .update(billzImportJobs)
        .set({status: 'queued', currentEntity: null, updatedAt: new Date()})
        .where(eq(billzImportJobs.status, 'running'));
    } catch (e) {
      this.logger.error(`BiLLZ import crash-recovery failed: ${errMsg(e)}`);
    }
    void this.drainFetch();
    void this.drainLoad();
  }

  /** Idle poll — picks up jobs enqueued while a loop was idle. Kicks both lanes. */
  @Interval('billz-import-poll', IDLE_POLL_MS)
  handlePoll(): void {
    void this.drainFetch();
    void this.drainLoad();
  }

  /** Called by the service right after a job is enqueued/resumed. Kicks both lanes. */
  wake(): void {
    void this.drainFetch();
    void this.drainLoad();
  }

  // ── FETCH lane ──────────────────────────────────────────────────────────────

  /** Drain every queued FETCH job, oldest first, then return. Non-overlapping. */
  private async drainFetch(): Promise<void> {
    if (this.fetchDraining) return;
    this.fetchDraining = true;
    try {
      for (;;) {
        const [job] = await this.db
          .select()
          .from(billzImportJobs)
          .where(
            and(
              eq(billzImportJobs.phase, 'fetch'),
              eq(billzImportJobs.status, 'queued'),
            ),
          )
          .orderBy(asc(billzImportJobs.createdAt))
          .limit(1);
        if (!job) break;
        await this.processFetchJob(job);
      }
    } catch (e) {
      this.logger.error(`BiLLZ fetch-lane error: ${errMsg(e)}`);
    } finally {
      this.fetchDraining = false;
    }
  }

  private async processFetchJob(jobRow: BillzImportJob): Promise<void> {
    const jobId = jobRow.id;
    const businessId = jobRow.businessId;
    try {
      const now = new Date();
      // Claim: queued → running. The where-guard drops the claim if the job was
      // paused/cancelled between the pick and here. started_at only set once.
      const claimed = await this.db
        .update(billzImportJobs)
        .set({
          status: 'running',
          startedAt: jobRow.startedAt ?? now,
          updatedAt: now,
        })
        .where(
          and(
            eq(billzImportJobs.id, jobId),
            eq(billzImportJobs.status, 'queued'),
            eq(billzImportJobs.phase, 'fetch'),
          ),
        )
        .returning({id: billzImportJobs.id});
      if (claimed.length === 0) return;

      for (const entity of ENTITY_ORDER) {
        if (!jobRow.entities.includes(entity)) continue;
        const outcome = await this.fetchEntity(jobId, businessId, entity);
        // paused/cancelled → stop, leaving staging + checkpoint intact for resume.
        if (outcome !== 'done') return;
      }

      // Every selected entity is staged → flip the job into the LOAD lane and
      // wake it. checkpoint is reset (load uses staging.status as its cursor, not
      // a page number). Guarded on running+fetch so a racing cancel is respected.
      await this.db
        .update(billzImportJobs)
        .set({
          phase: 'load',
          status: 'queued',
          currentEntity: null,
          checkpoint: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(billzImportJobs.id, jobId),
            eq(billzImportJobs.status, 'running'),
            eq(billzImportJobs.phase, 'fetch'),
          ),
        );
      void this.drainLoad();
    } catch (e) {
      await this.failJob(jobId, errMsg(e));
    }
  }

  /**
   * Page-loop one entity from its checkpoint, writing RAW records into staging.
   * Returns 'done' when the entity is fully staged, or 'paused'/'cancelled' when
   * a control action interrupted it (checkpoint/counters left intact for resume).
   */
  private async fetchEntity(
    jobId: string,
    businessId: string,
    entity: ImportEntity,
  ): Promise<'done' | 'paused' | 'cancelled'> {
    const job = await this.getJob(jobId);
    if (!job) return 'cancelled';

    const counters: JobCounters = {...(job.counters ?? {})};
    if (!counters[entity]) counters[entity] = emptyEntityCounter();
    const checkpoint: JobCheckpoint = {...(job.checkpoint ?? {})};
    let page = checkpoint[entity]?.page ?? 1;

    await this.db
      .update(billzImportJobs)
      .set({currentEntity: entity, updatedAt: new Date()})
      .where(eq(billzImportJobs.id, jobId));

    const limit = entity === 'customers' ? CUSTOMERS_LIMIT : PRODUCTS_LIMIT;

    for (;;) {
      // Token via the existing service (proactively re-logs in near expiry).
      const token = await this.billz.getAccessToken(businessId);

      let staged: StagedPage;
      if (entity === 'products') {
        staged = await this.fetchProductsToStaging(
          businessId,
          jobId,
          token,
          page,
        );
      } else if (entity === 'customers') {
        staged = await this.fetchCustomersToStaging(
          businessId,
          jobId,
          token,
          page,
        );
      } else {
        staged = await this.fetchImagesToStaging(
          businessId,
          jobId,
          token,
          page,
        );
      }

      const fc = counters[entity].fetch;
      if (staged.total != null && fc.total == null) fc.total = staged.total;
      fc.done += staged.staged;
      fc.failed += staged.failed;
      checkpoint[entity] = {page: page + 1};

      // Staging insert + counters + checkpoint committed together, so a crash
      // between them can't double-stage on resume. One batched insert per page.
      await this.db.transaction(async (tx) => {
        if (staged.rows.length > 0) {
          await tx.insert(billzStaging).values(staged.rows);
        }
        await tx
          .update(billzImportJobs)
          .set({counters, checkpoint, updatedAt: new Date()})
          .where(eq(billzImportJobs.id, jobId));
      });

      const status = await this.readStatus(jobId);
      if (status === 'paused') return 'paused';
      if (status === 'cancelled') return 'cancelled';

      // A short page is the last page.
      if (staged.fetched < limit) return 'done';
      page += 1;
    }
  }

  /** Stage one /v2/products page as raw product records. */
  private async fetchProductsToStaging(
    businessId: string,
    jobId: string,
    token: string,
    page: number,
  ): Promise<StagedPage> {
    const {records, total} = await this.fetchProductsPage(token, page);
    const rows: NewBillzStaging[] = [];
    let failed = 0;
    for (const raw of records) {
      const rec = asRecord(raw) ?? {};
      const billzId = str(rec.id) ?? null;
      // No BiLLZ id → the record can't be tracked; count as a fetch failure and
      // don't stage it (MG2: real products always carry an id).
      if (!billzId) {
        failed += 1;
        continue;
      }
      rows.push({
        id: generateId(),
        businessId,
        jobId,
        entity: 'products',
        billzId,
        payload: rec,
        status: 'pending',
      });
    }
    return {fetched: records.length, total, staged: rows.length, failed, rows};
  }

  /** Stage one /v1/client page as raw customer records. */
  private async fetchCustomersToStaging(
    businessId: string,
    jobId: string,
    token: string,
    page: number,
  ): Promise<StagedPage> {
    const {records, total} = await this.fetchCustomersPage(token, page);
    const rows: NewBillzStaging[] = [];
    let failed = 0;
    for (const raw of records) {
      const rec = asRecord(raw) ?? {};
      const billzId = str(rec.id) ?? null;
      if (!billzId) {
        failed += 1;
        continue;
      }
      rows.push({
        id: generateId(),
        businessId,
        jobId,
        entity: 'customers',
        billzId,
        payload: rec,
        status: 'pending',
      });
    }
    return {fetched: records.length, total, staged: rows.length, failed, rows};
  }

  /**
   * Re-scan the /v2/products pages (rate-limited) purely to harvest image URLs;
   * the actual CDN downloads happen in the LOAD lane, never in this fetch lane
   * (downloads are not the API — they must stay out of the rate-limited budget,
   * MIGRATSIYA §3.2). One staging row per product that has an image, with
   * payload = {productKey: barcode-or-sku, imageUrl}. Products without an image
   * contribute nothing.
   *
   * fetch.total for images = the product count BiLLZ reports (products scanned);
   * fetch.done = image URLs actually staged (≤ scanned); fetch.failed = products
   * that have an image but no barcode/sku (unattachable at load time).
   */
  private async fetchImagesToStaging(
    businessId: string,
    jobId: string,
    token: string,
    page: number,
  ): Promise<StagedPage> {
    const {records, total} = await this.fetchProductsPage(token, page);
    const rows: NewBillzStaging[] = [];
    let failed = 0;
    for (const raw of records) {
      const rec = asRecord(raw) ?? {};
      const imageUrl = pickMainImage(rec);
      if (!imageUrl) continue; // no image → contributes no staging row (silent)
      const barcode = (str(rec.barcode) ?? '').trim() || null;
      const sku = (str(rec.sku) ?? '').trim() || null;
      const productKey = barcode ?? sku;
      if (!productKey) {
        failed += 1;
        continue;
      }
      rows.push({
        id: generateId(),
        businessId,
        jobId,
        entity: 'images',
        billzId: str(rec.id) ?? null,
        payload: {productKey, imageUrl},
        status: 'pending',
      });
    }
    return {fetched: records.length, total, staged: rows.length, failed, rows};
  }

  private async fetchProductsPage(
    token: string,
    page: number,
  ): Promise<{records: unknown[]; total: number | null}> {
    const {status, body} = await this.client.request(
      `/v2/products?page=${page}&limit=${PRODUCTS_LIMIT}`,
      {
        method: 'GET',
        headers: {accept: 'application/json', Authorization: `Bearer ${token}`},
      },
    );
    if (status !== 200) {
      throw new Error(`BiLLZ /v2/products returned HTTP ${status}`);
    }
    // extractList never throws now; treat an unrecognized shape (no array under
    // any known key) as a fatal error here so a renamed shape surfaces loudly
    // instead of silently importing nothing (an empty last page is arrayFound).
    const {records, total, arrayFound} = extractList(body);
    if (!arrayFound) {
      throw new Error(
        'Unexpected /v2/products response shape (no record array found)',
      );
    }
    return {records, total};
  }

  private async fetchCustomersPage(
    token: string,
    page: number,
  ): Promise<{records: unknown[]; total: number | null}> {
    const {status, body} = await this.client.request(
      `/v1/client?page=${page}&limit=${CUSTOMERS_LIMIT}`,
      {
        method: 'GET',
        headers: {accept: 'application/json', Authorization: `Bearer ${token}`},
      },
    );
    if (status !== 200) {
      throw new Error(`BiLLZ /v1/client returned HTTP ${status}`);
    }
    // A non-array/unrecognized page → the job fails with a clear error.
    const {records, total, arrayFound} = extractList(body);
    if (!arrayFound) {
      throw new Error(
        'Unexpected /v1/client response shape (no record array found)',
      );
    }
    return {records, total};
  }

  // ── LOAD lane ───────────────────────────────────────────────────────────────

  /** Drain every queued LOAD job, oldest first, then return. Non-overlapping. */
  private async drainLoad(): Promise<void> {
    if (this.loadDraining) return;
    this.loadDraining = true;
    try {
      for (;;) {
        const [job] = await this.db
          .select()
          .from(billzImportJobs)
          .where(
            and(
              eq(billzImportJobs.phase, 'load'),
              eq(billzImportJobs.status, 'queued'),
            ),
          )
          .orderBy(asc(billzImportJobs.createdAt))
          .limit(1);
        if (!job) break;
        await this.processLoadJob(job);
      }
    } catch (e) {
      this.logger.error(`BiLLZ load-lane error: ${errMsg(e)}`);
    } finally {
      this.loadDraining = false;
    }
  }

  private async processLoadJob(jobRow: BillzImportJob): Promise<void> {
    const jobId = jobRow.id;
    const businessId = jobRow.businessId;
    try {
      const now = new Date();
      // Claim: queued → running (guarded on phase='load'). started_at was already
      // set in the fetch phase; keep it, only backfill if somehow missing.
      const claimed = await this.db
        .update(billzImportJobs)
        .set({
          status: 'running',
          startedAt: jobRow.startedAt ?? now,
          updatedAt: now,
        })
        .where(
          and(
            eq(billzImportJobs.id, jobId),
            eq(billzImportJobs.status, 'queued'),
            eq(billzImportJobs.phase, 'load'),
          ),
        )
        .returning({id: billzImportJobs.id});
      if (claimed.length === 0) return;

      const mainBranch = await this.branchService.ensureDefault(businessId);

      for (const entity of ENTITY_ORDER) {
        if (!jobRow.entities.includes(entity)) continue;
        const outcome = await this.loadEntity(
          jobId,
          businessId,
          entity,
          mainBranch.id,
        );
        if (outcome !== 'done') return;
      }

      // Complete only if still running (a cancel could race the last batch check).
      await this.db
        .update(billzImportJobs)
        .set({
          status: 'completed',
          currentEntity: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(billzImportJobs.id, jobId),
            eq(billzImportJobs.status, 'running'),
            eq(billzImportJobs.phase, 'load'),
          ),
        );
    } catch (e) {
      await this.failJob(jobId, errMsg(e));
    }
  }

  /**
   * Drain one entity's still-'pending' staging rows in LOAD_BATCH-sized batches,
   * upserting each into the real tables (the idempotent mapping) and writing the
   * audit item. Returns 'done' when no pending row remains, or 'paused'/'cancelled'
   * when a control action interrupted it. staging.status is the resume cursor, so
   * no page checkpoint is needed here — a re-run picks up the first 'pending' row.
   */
  private async loadEntity(
    jobId: string,
    businessId: string,
    entity: ImportEntity,
    mainBranchId: string,
  ): Promise<'done' | 'paused' | 'cancelled'> {
    const job = await this.getJob(jobId);
    if (!job) return 'cancelled';
    const counters: JobCounters = {...(job.counters ?? {})};
    if (!counters[entity]) counters[entity] = emptyEntityCounter();

    await this.db
      .update(billzImportJobs)
      .set({currentEntity: entity, updatedAt: new Date()})
      .where(eq(billzImportJobs.id, jobId));

    // load.total = number of staging rows for this entity (set once, at start).
    if (counters[entity].load.total == null) {
      const [{value: total}] = await this.db
        .select({value: count()})
        .from(billzStaging)
        .where(
          and(eq(billzStaging.jobId, jobId), eq(billzStaging.entity, entity)),
        );
      counters[entity].load.total = Number(total);
      await this.db
        .update(billzImportJobs)
        .set({counters, updatedAt: new Date()})
        .where(eq(billzImportJobs.id, jobId));
    }

    for (;;) {
      const batch = await this.db
        .select()
        .from(billzStaging)
        .where(
          and(
            eq(billzStaging.jobId, jobId),
            eq(billzStaging.entity, entity),
            eq(billzStaging.status, 'pending'),
          ),
        )
        .orderBy(asc(billzStaging.createdAt))
        .limit(LOAD_BATCH);
      if (batch.length === 0) return 'done';

      const audit: NewBillzImportItem[] = [];
      const loadedIds: string[] = [];
      const failedRows: {id: string; error: string}[] = [];
      const lc = counters[entity].load;

      for (const row of batch) {
        let outcome: RowLoad;
        if (entity === 'products') {
          outcome = await this.loadProductRow(
            businessId,
            mainBranchId,
            row.payload,
          );
        } else if (entity === 'customers') {
          outcome = await this.loadCustomerRow(businessId, row.payload);
        } else {
          outcome = await this.loadImageRow(businessId, row.payload);
        }

        audit.push({
          id: generateId(),
          businessId,
          jobId,
          entity,
          billzId: row.billzId,
          name: outcome.label,
          status: outcome.ok ? 'success' : 'failed',
          error: outcome.error,
        });
        if (outcome.ok) {
          lc.done += 1;
          loadedIds.push(row.id);
        } else {
          lc.failed += 1;
          failedRows.push({id: row.id, error: outcome.error ?? 'failed'});
        }
      }

      // Audit rows + staging status flips + load counters committed together.
      const now = new Date();
      await this.db.transaction(async (tx) => {
        if (audit.length > 0) await tx.insert(billzImportItems).values(audit);
        if (loadedIds.length > 0) {
          await tx
            .update(billzStaging)
            .set({status: 'loaded', error: null, loadedAt: now})
            .where(inArray(billzStaging.id, loadedIds));
        }
        for (const f of failedRows) {
          await tx
            .update(billzStaging)
            .set({status: 'failed', error: f.error})
            .where(eq(billzStaging.id, f.id));
        }
        await tx
          .update(billzImportJobs)
          .set({counters, updatedAt: new Date()})
          .where(eq(billzImportJobs.id, jobId));
      });

      const status = await this.readStatus(jobId);
      if (status === 'paused') return 'paused';
      if (status === 'cancelled') return 'cancelled';
    }
  }

  /** Apply one staged product record → products (+branchStock +opening batch). */
  private async loadProductRow(
    businessId: string,
    mainBranchId: string,
    payload: unknown,
  ): Promise<RowLoad> {
    const rec = asRecord(payload) ?? {};
    const fallback = str(rec.name) ?? null;
    try {
      const label = await this.upsertProduct(businessId, mainBranchId, rec);
      return {label, ok: true, error: null};
    } catch (e) {
      return {label: fallback, ok: false, error: errMsg(e)};
    }
  }

  /** Apply one staged customer record → users. */
  private async loadCustomerRow(
    businessId: string,
    payload: unknown,
  ): Promise<RowLoad> {
    // Name/phone field candidates live in the SHARED mapCustomer (billz-mapping.ts),
    // the same reader the MG2 probe previews (fields still UNCONFIRMED).
    const m = mapCustomer(payload);
    const rawName = m.name ?? '';
    const phone = m.phone ?? '';
    const label =
      [rawName, phone].filter((s) => s.length > 0).join(' ') || null;
    try {
      if (!phone && !rawName) throw new Error('Missing phone and name');
      // users.phone is NOT NULL and the upsert key → a customer without a phone
      // cannot be stored (deviation noted in the report).
      if (!phone) throw new Error('Missing phone number');
      await this.upsertCustomer(businessId, phone, rawName);
      return {label, ok: true, error: null};
    } catch (e) {
      return {label, ok: false, error: errMsg(e)};
    }
  }

  /**
   * Apply one staged image row → download the CDN URL and attach it to the
   * matching KPOS product (by productKey). The product must already exist (its
   * products load ran first, ENTITY_ORDER), else the row fails "product not
   * imported". Downloads are paced ≥600ms + jitter (§3.2), 10s timeout + 1 retry.
   */
  private async loadImageRow(
    businessId: string,
    payload: unknown,
  ): Promise<RowLoad> {
    const p = asRecord(payload) ?? {};
    const productKey = (str(p.productKey) ?? '').trim() || null;
    const imageUrl = (str(p.imageUrl) ?? '').trim() || null;
    // The image payload carries no product name, so the audit label is the key.
    const label = productKey;
    if (!imageUrl) return {label, ok: false, error: 'Missing image URL'};
    if (!productKey) return {label, ok: false, error: 'Missing product key'};

    const product = await this.findProductByProductKey(businessId, productKey);
    if (!product) {
      return {label, ok: false, error: 'product not imported'};
    }
    try {
      await this.paceImage();
      const {buffer, contentType} = await this.downloadImage(imageUrl);
      const {url} = await this.storage.upload(buffer, {
        contentType,
        prefix: 'products',
      });
      await this.db
        .update(products)
        .set({image: url, updatedAt: new Date()})
        .where(eq(products.id, product.id));
      return {label, ok: true, error: null};
    } catch (e) {
      return {label, ok: false, error: errMsg(e)};
    }
  }

  /**
   * Idempotent upsert of one BiLLZ product (or variant row) into KPOS.
   * Key: barcode if non-empty else sku (→ products.code). Existing → update
   * name/prices/brand/category/unit and SET (absolute, no doubling) main-branch
   * stock. New → insert + seed branch_stock + opening inventory batch, keeping
   * products.quantity = sum-across-branches. Returns the display label.
   *
   * MG2 to confirm: retail-price/stock field names (see mapProduct); the
   * product_type_id (service type 5a0e556a…) is imported as a normal product
   * because the products table has no type/service flag.
   *
   * The raw→field extraction is the SHARED mapProduct (billz-mapping.ts) — the
   * same function the MG2 probe previews — so import and preview never drift.
   */
  private async upsertProduct(
    businessId: string,
    mainBranchId: string,
    rec: Record<string, unknown>,
  ): Promise<string> {
    const m = mapProduct(rec);
    const name = m.name ?? '';
    const sku = m.sku;
    const barcode = m.barcode;
    const key = barcode ?? sku;
    if (!name) throw new Error('Missing product name');
    if (!key) throw new Error('Missing sku and barcode (no upsert key)');

    let brandId: string | null = null;
    if (m.brandName)
      brandId = await this.findOrCreateBrand(businessId, m.brandName);

    // KPOS categories are FLAT (no parent hierarchy column) — mapProduct already
    // reduced categories[] to categories[0].name.
    let categoryId: string | null = null;
    if (m.categoryName)
      categoryId = await this.findOrCreateCategory(businessId, m.categoryName);

    let unit: Unit | null = null;
    if (m.unitName || m.unitShortName) {
      unit = await this.findOrCreateUnit(
        businessId,
        m.unitShortName ?? undefined,
        m.unitName ?? undefined,
      );
    }
    const unitId = unit?.id ?? null;
    const quantityType = unit ? (unit.precision > 0 ? 'kg' : 'piece') : null;

    const {priceIn, priceOut, stock} = m;

    // Variant name (v1 strategy, §5.1) — mapProduct appended attribute values to
    // the base name → "Air Jordan 1 (42, Qora)". Falls back to the base name.
    const finalName = (m.variantName ?? name).slice(0, 255);

    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            barcode
              ? eq(products.barcode, barcode)
              : eq(products.code, sku as string),
          ),
        )
        .limit(1);

      if (existing) {
        await tx
          .update(products)
          .set({
            name: finalName,
            code: sku,
            barcode,
            priceIn,
            priceOut,
            brandId: brandId ?? existing.brandId,
            categoryId: categoryId ?? existing.categoryId,
            unitId: unitId ?? existing.unitId,
            quantityType: quantityType ?? existing.quantityType,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(products.id, existing.id));
        // Absolute set so a re-run never doubles stock (keeps the sum invariant).
        await setBranchStock(tx, businessId, existing.id, mainBranchId, stock);
      } else {
        const id = generateId();
        await tx.insert(products).values({
          id,
          businessId,
          name: finalName,
          code: sku,
          barcode,
          priceIn,
          priceOut,
          quantity: stock,
          quantityType,
          unitId,
          categoryId,
          brandId,
          branchId: mainBranchId,
          isActive: true,
        });
        await tx.insert(branchStock).values({
          id: generateId(),
          businessId,
          productId: id,
          branchId: mainBranchId,
          quantity: stock,
        });
        // Opening batch for initial stock (mirrors ProductService.create) so
        // FIFO/COGS has a lot to consume when the imported item is later sold.
        if (stock > 0) {
          await tx.insert(inventoryBatches).values({
            id: generateId(),
            businessId,
            productId: id,
            branchId: mainBranchId,
            receiptItemId: null,
            priceIn,
            priceOut,
            qtyReceived: stock,
            qtyRemaining: stock,
          });
        }
      }
    });

    return finalName;
  }

  /** Upsert a customer by phone within the business (revives a soft-deleted one). */
  private async upsertCustomer(
    businessId: string,
    phone: string,
    name: string,
  ): Promise<void> {
    const [existing] = await this.db
      .select({id: users.id, name: users.name})
      .from(users)
      .where(and(eq(users.businessId, businessId), eq(users.phone, phone)))
      .limit(1);
    if (existing) {
      await this.db
        .update(users)
        .set({
          name: (name || existing.name).slice(0, 255),
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id));
    } else {
      await this.db.insert(users).values({
        id: generateId(),
        businessId,
        name: (name || phone).slice(0, 255),
        phone: phone.slice(0, 50),
        isActive: true,
      });
    }
  }

  /** Find an active product whose barcode OR code equals the staged productKey. */
  private async findProductByProductKey(
    businessId: string,
    productKey: string,
  ): Promise<{id: string} | null> {
    const [p] = await this.db
      .select({id: products.id})
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.isActive, true),
          or(eq(products.barcode, productKey), eq(products.code, productKey)),
        ),
      )
      .limit(1);
    return p ?? null;
  }

  /** ≥600ms + 100-300ms jitter between CDN downloads (§3.2 block-risk pacing). */
  private async paceImage(): Promise<void> {
    const jitter =
      IMAGE_JITTER_MIN_MS +
      Math.floor(
        Math.random() * (IMAGE_JITTER_MAX_MS - IMAGE_JITTER_MIN_MS + 1),
      );
    const gap = IMAGE_MIN_GAP_MS + jitter;
    const wait = this.lastImageAt + gap - Date.now();
    if (wait > 0) await delay(wait);
    this.lastImageAt = Date.now();
  }

  /** Download one image (10s timeout, one retry) — direct CDN fetch, NOT via the API client. */
  private async downloadImage(
    url: string,
  ): Promise<{buffer: Buffer; contentType: string}> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
      try {
        const res = await fetch(url, {signal: controller.signal});
        if (!res.ok) throw new Error(`image download HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length === 0) throw new Error('empty image body');
        return {buffer, contentType};
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await delay(500); // one retry
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('image download failed');
  }

  // ── find-or-create helpers (case-insensitive, business-scoped) ──────────────
  private async findOrCreateBrand(
    businessId: string,
    name: string,
  ): Promise<string> {
    const [found] = await this.db
      .select({id: brands.id})
      .from(brands)
      .where(
        and(
          eq(brands.businessId, businessId),
          eq(brands.isActive, true),
          ilike(brands.name, name),
        ),
      )
      .limit(1);
    if (found) return found.id;
    const id = generateId();
    await this.db
      .insert(brands)
      .values({id, businessId, name: name.slice(0, 255), isActive: true});
    return id;
  }

  private async findOrCreateCategory(
    businessId: string,
    name: string,
  ): Promise<string> {
    const [found] = await this.db
      .select({id: categories.id})
      .from(categories)
      .where(
        and(
          eq(categories.businessId, businessId),
          eq(categories.isDeleted, false),
          ilike(categories.name, name),
        ),
      )
      .limit(1);
    if (found) return found.id;
    const id = generateId();
    await this.db
      .insert(categories)
      .values({id, businessId, name: name.slice(0, 255), isDeleted: false});
    return id;
  }

  /**
   * Match a unit by short_name OR name (case-insensitive) among the business's
   * own rows + global system rows; create a business unit otherwise. BiLLZ gives
   * no precision, so new units default to precision 0 (piece). MG2 to confirm.
   */
  private async findOrCreateUnit(
    businessId: string,
    shortName?: string,
    name?: string,
  ): Promise<Unit | null> {
    const short = (shortName ?? '').trim();
    const nm = (name ?? '').trim();
    if (!short && !nm) return null;

    const nameConds: SQL[] = [];
    if (short) nameConds.push(ilike(units.shortName, short));
    if (nm) nameConds.push(ilike(units.name, nm));
    const nameMatch = nameConds.length === 1 ? nameConds[0] : or(...nameConds);

    const [found] = await this.db
      .select()
      .from(units)
      .where(
        and(
          or(eq(units.businessId, businessId), isNull(units.businessId)),
          eq(units.isActive, true),
          nameMatch,
        ),
      )
      .limit(1);
    if (found) return found;

    const [created] = await this.db
      .insert(units)
      .values({
        id: generateId(),
        businessId,
        name: (nm || short).slice(0, 100),
        shortName: (short || nm).slice(0, 20),
        precision: 0,
      })
      .returning();
    return created;
  }

  // ── job row reads + shared failure path ─────────────────────────────────────
  private async getJob(jobId: string): Promise<BillzImportJob | null> {
    const [j] = await this.db
      .select()
      .from(billzImportJobs)
      .where(eq(billzImportJobs.id, jobId))
      .limit(1);
    return j ?? null;
  }

  private async readStatus(jobId: string): Promise<string> {
    const [j] = await this.db
      .select({status: billzImportJobs.status})
      .from(billzImportJobs)
      .where(eq(billzImportJobs.id, jobId))
      .limit(1);
    return j?.status ?? 'cancelled';
  }

  /** Mark a running job failed (either lane). No-op if it's no longer running. */
  private async failJob(jobId: string, message: string): Promise<void> {
    await this.db
      .update(billzImportJobs)
      .set({
        status: 'failed',
        error: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(billzImportJobs.id, jobId),
          eq(billzImportJobs.status, 'running'),
        ),
      );
    this.logger.warn(`BiLLZ import job ${jobId} failed: ${message}`);
  }
}
