-- Keyset ("cursor") pagination for the heavy list screens — the ordering indexes.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why these exist: every one of these lists is read newest-first, but none of
-- the three tables had an index on its sort key. So `ORDER BY created_at DESC
-- LIMIT 10` had to read every row of the business and sort them — on every
-- page, for a ten-row window. The cursor in common/cursor.ts turns the paging
-- into `(created_at, id) < (...)`, and these indexes are what turn THAT into a
-- range scan. Without them the cursor still fixes the skipped/duplicated rows,
-- but not the speed.
--
-- CONCURRENTLY: these tables are written to while the shop is open, and a plain
-- CREATE INDEX takes an ACCESS EXCLUSIVE lock for the whole build. CONCURRENTLY
-- cannot run inside a transaction block — run this file with psql (statement at
-- a time, autocommit), not inside BEGIN/COMMIT. If one is interrupted it leaves
-- an INVALID index behind: DROP INDEX it and re-run.

-- Catalogue list: /products, ordered created_at DESC, id DESC. Partial on
-- is_active because the list never shows archived products, which keeps the
-- index to exactly the rows it is scanned for.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_business_created_idx"
  ON "products" ("business_id", "created_at" DESC, "id" DESC)
  WHERE "is_active";

-- Sales list: /orders ("Barcha sotuvlar", online orders). The table that grows
-- forever and is always read newest-first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_business_created_idx"
  ON "orders" ("business_id", "created_at" DESC, "id" DESC);

-- Customers list: /loyalty/customers, ordered by balance then signup date.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_business_bonus_idx"
  ON "users" ("business_id", "bonus_balance" DESC, "created_at" DESC, "id" DESC)
  WHERE "is_active";
