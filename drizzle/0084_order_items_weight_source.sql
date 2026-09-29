-- Where a weighed line's amount came from: the live scale's audit trail.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why: a till with a live scale (Web Serial) fills a kilogram line from the
-- scale, but the cashier can still type over it — a scale can't weigh
-- everything, and a queue won't wait for a broken one. The owner needs to see
-- which lines were typed on a till that had a scale, so every kilogram line
-- now records 'scale' | 'label' | 'manual'; null means that till had no live
-- scale, which is how every existing row reads. See order/weight-source.ts
-- and TAROZI.md §8.
--
-- The index backs the sales list's "hand-changed weight" filter. Partial on
-- 'manual' because those lines are the exception, so it stays small however
-- long the ledger grows.
--
-- CONCURRENTLY: order_items is written on every sale. It cannot run inside a
-- transaction block — run this file with psql (autocommit), not inside
-- BEGIN/COMMIT. An interrupted build leaves an INVALID index behind: DROP
-- INDEX it and re-run.

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "weight_source" varchar(10);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "order_items_manual_weight_idx"
  ON "order_items" ("business_id", "order_id")
  WHERE "weight_source" = 'manual';
