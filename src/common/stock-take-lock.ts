import type {Cache} from '@nestjs/cache-manager';
import {sql} from 'drizzle-orm';
import {CacheKeys, TTL} from '../cache/cache.util';

// Minimal structural type for the Drizzle db handle — just what we call here.
// Avoids importing DatabaseService so this stays a leaf util with no DI coupling.
interface DbExecutor {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

// Whether an inventory count (stock-take) is open for a business — the flag that
// freezes sales and shift-opening while a count relies on a stable book-quantity
// snapshot (INVENTARIZATSIYA.md §9.4).
//
// Cache-aside: the in-memory cache is the hot-path read (a sale hits this on
// every checkout), but the DB row is the source of truth. A cache miss falls
// back to a guarded query and repopulates, so a process restart or an expired
// entry self-heals. Fail-open on any error (e.g. the stock_takes table not yet
// migrated) so the till is never stuck.
//
// Maintained by StockTakeService: set(true) on start, cleared on completion.
export async function isStockTakeActive(
  cache: Cache,
  db: DbExecutor,
  businessId: string,
): Promise<boolean> {
  try {
    // wrap = cache-aside in one call: return the cached flag, or run the query,
    // cache it, and return it. try/catch keeps it fail-open (see below).
    return await cache.wrap(
      CacheKeys.stockTakeActive(businessId),
      () => queryStockTakeActive(db, businessId),
      TTL.STOCK_TAKE_ACTIVE,
    );
  } catch {
    // Table missing / transient error — fail open (nothing cached) so the till
    // is never stuck; the next call retries the DB.
    return false;
  }
}

async function queryStockTakeActive(
  db: DbExecutor,
  businessId: string,
): Promise<boolean> {
  // db.execute() returns a bare row array or a { rows } object depending on the
  // driver — normalise both.
  const result = (await db.execute(sql`
    SELECT 1 FROM stock_takes
    WHERE business_id = ${businessId} AND status = 'in_progress'
    LIMIT 1
  `)) as unknown;
  const rows = (result as {rows?: unknown[]}).rows ?? (result as unknown[]);
  return rows.length > 0;
}

// Records that a count just opened (hot path reads this instead of the DB).
export async function setStockTakeActive(
  cache: Cache,
  businessId: string,
): Promise<void> {
  await cache.set(
    CacheKeys.stockTakeActive(businessId),
    true,
    TTL.STOCK_TAKE_ACTIVE,
  );
}

// Drops the lock when a count completes; the next check re-reads the DB (now
// clear) and caches `false`.
export async function clearStockTakeActive(
  cache: Cache,
  businessId: string,
): Promise<void> {
  await cache.del(CacheKeys.stockTakeActive(businessId));
}
