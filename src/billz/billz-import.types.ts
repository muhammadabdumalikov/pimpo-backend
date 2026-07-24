// Shared BiLLZ-import types + the public JobDto/ItemDto contract the frontend
// is built against (see MIGRATSIYA.md MG3/MG4/MG5). Dates are ISO strings.

import type {BillzImportItem, BillzImportJob} from '../database/schema';
import type {CustomerMapping, ProductMapping} from './billz-mapping';

export type ImportEntity = 'products' | 'customers' | 'images';

// The entities the MG2 probe can preview (images have no standalone list page).
export type ProbeEntity = 'products' | 'customers';
export const PROBE_ENTITIES: readonly ProbeEntity[] = [
  'products',
  'customers',
] as const;

// The two decoupled lanes a job flows through: 'fetch' (rate-limited BiLLZ pull
// into billz_staging) then 'load' (staging → real KPOS tables).
export type ImportPhase = 'fetch' | 'load';

// The three importable entities, and the FIXED order the worker runs them in.
export const IMPORT_ENTITIES: readonly ImportEntity[] = [
  'products',
  'customers',
  'images',
] as const;
export const ENTITY_ORDER: readonly ImportEntity[] = IMPORT_ENTITIES;

// One progress triple. Reused for both dimensions (fetch + load) of an entity.
export interface CounterDim {
  total: number | null;
  done: number;
  failed: number;
}

// Per-entity progress now has TWO dimensions:
//  - fetch.total = records BiLLZ reports for the entity (null if unknown);
//    fetch.done  = raw records written to staging;
//    fetch.failed = records/pages that failed to fetch or had no billz id.
//  - load.total  = staging rows for the entity (set when its load starts);
//    load.done   = rows successfully upserted into real tables;
//    load.failed = rows that failed mapping/insert.
export interface EntityCounter {
  fetch: CounterDim;
  load: CounterDim;
}

export type JobCounters = Record<string, EntityCounter>;
// Fetch-phase resume checkpoint, per entity. 'products' and 'images' re-scan the
// catalog by CATEGORY CHUNKING (POST /v2/product-search-with-filters per
// category) → {categoryId, page}, where `categoryId` is the category currently
// being paged and `page` is the page WITHIN that category; 'customers' pages
// /v1/client page-by-page → {page}. All fields optional so one type covers both
// pagination styles.
export type JobCheckpoint = Record<
  string,
  {page?: number; categoryId?: string}
>;

/** Build the initial (all-zero) counters for the chosen entities. */
export function initialCounters(entities: ImportEntity[]): JobCounters {
  const counters: JobCounters = {};
  for (const e of entities) {
    counters[e] = {
      fetch: {total: null, done: 0, failed: 0},
      load: {total: null, done: 0, failed: 0},
    };
  }
  return counters;
}

export interface JobDto {
  id: string;
  status: string;
  phase: string;
  entities: string[];
  currentEntity: string | null;
  counters: JobCounters;
  error: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ItemDto {
  id: string;
  entity: string;
  name: string | null;
  billzId: string | null;
  status: string;
  error: string | null;
  createdAt: string | null;
}

/** Map a job row to the camelCase, ISO-date JobDto the API returns. */
export function toJobDto(job: BillzImportJob): JobDto {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase ?? 'fetch',
    entities: job.entities ?? [],
    currentEntity: job.currentEntity ?? null,
    counters: (job.counters ?? {}) as JobCounters,
    error: job.error ?? null,
    createdAt: job.createdAt ? job.createdAt.toISOString() : null,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

// ── MG2 probe contract (GET /billz/probe) ───────────────────────────────────

/** One sampled record: its raw JSON + how the SHARED mapper reads it. */
export interface ProbeSample<M> {
  /** The record's BiLLZ id (mapped.billzId), or null. */
  billzId: string | null;
  /** The raw BiLLZ record exactly as returned. */
  raw: Record<string, unknown>;
  /** The mapped fields — IDENTICAL to what the import would read. */
  mapped: M;
}

/**
 * The probe response. `mapped` is a ProductMapping for entity='products' and a
 * CustomerMapping for entity='customers'. Built entirely from the shared
 * billz-mapping module so it can never drift from the real import.
 */
export interface ProbeResponse<M = ProductMapping | CustomerMapping> {
  entity: ProbeEntity;
  /** Total the API reports for the entity (from extractList), or null. */
  totalReported: number | null;
  /** Top-level keys of the raw response (confirm which holds the array). */
  envelopeKeys: string[];
  /** Sorted union of keys seen across the sampled records. */
  recordKeys: string[];
  /** Up to 5 sampled records with their raw JSON + mapped fields. */
  samples: ProbeSample<M>[];
  /** Human-readable flags for every guessed field NOT found in the sample. */
  warnings: string[];
}

export type ProductProbeResponse = ProbeResponse<ProductMapping>;
export type CustomerProbeResponse = ProbeResponse<CustomerMapping>;

/** Map an item row to the ItemDto the API returns. */
export function toItemDto(item: BillzImportItem): ItemDto {
  return {
    id: item.id,
    entity: item.entity,
    name: item.name ?? null,
    billzId: item.billzId ?? null,
    status: item.status,
    error: item.error ?? null,
    createdAt: item.createdAt ? item.createdAt.toISOString() : null,
  };
}
