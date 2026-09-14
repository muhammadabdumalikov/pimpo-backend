-- Sale history per product — the lookup index behind /products/:id/sales.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why: order_items had nothing but its primary key, so "every line for THIS
-- product" was a sequential scan of the whole sales ledger — a table that only
-- ever grows. The screen it feeds is opened from a row in the catalogue, so it
-- is asked one product at a time, all day. business_id leads because every
-- query here is tenant-scoped anyway and it keeps the index useful for other
-- per-business item reads; product_id is what actually narrows it to a handful
-- of rows, after which the join to orders is by primary key and the
-- newest-first sort is over that handful.
--
-- CONCURRENTLY: order_items is written on every sale. It cannot run inside a
-- transaction block — run this file with psql (autocommit), not inside
-- BEGIN/COMMIT. An interrupted build leaves an INVALID index behind: DROP
-- INDEX it and re-run.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_business_product_idx"
  ON "order_items" ("business_id", "product_id");
