-- Correcting a till kirim/chiqim typed wrong (wrong currency, amount, kind).
--
-- Idempotent; safe to re-run.
--
-- Nothing is edited in place: the wrong movement is marked cancelled (who and
-- when), its ledger row is stornoed, and the corrected one is written as a new
-- movement that points back at it. Every read that sums movements skips the
-- cancelled ones.

ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS cancelled_at timestamp;
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS cancelled_by_id varchar(36);
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS cancelled_by_name varchar(255);
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS replaces_id varchar(36);
