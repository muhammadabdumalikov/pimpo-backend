-- Keyset ("cursor") paging for Moliya → Tranzaksiyalar.
--
-- Idempotent; safe to re-run.
--
-- The list is read newest-first as `ORDER BY created_at DESC, id DESC` and
-- pages with `(created_at, id) < (...)` (common/cursor.ts). The old index was
-- (business_id, created_at): it covers the date filter but not the id
-- tiebreak, so every page still sorted the business's whole ledger. This one
-- matches the ORDER BY exactly, and its (business_id, created_at) prefix keeps
-- serving the report and date-range reads the old one did — so the old one is
-- dropped once the new one is built.
--
-- CONCURRENTLY: the ledger is written by every sale and shift close while the
-- shop is open, and a plain CREATE INDEX would block those writes for the whole
-- build. The runner sees CONCURRENTLY and runs this file statement by
-- statement, outside a transaction. If a build is interrupted it leaves an
-- INVALID index: DROP INDEX it and re-run.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "financial_transactions_business_created_id_idx"
  ON "financial_transactions" ("business_id", "created_at" DESC, "id" DESC);

DROP INDEX CONCURRENTLY IF EXISTS "financial_transactions_business_created_idx";
