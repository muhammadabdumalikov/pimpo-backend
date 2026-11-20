-- Approving a closed till shift ("smenani tasdiqlash").
--
-- The column adds are idempotent. The backfill is relative to when it runs,
-- so it relies on the runner applying this file once (ops.schema_migrations).
--
-- After a shift is closed, someone with shift:approve reviews it and
-- approves it. From then on its kirim/chiqim can no longer be corrected or
-- cancelled. Until then they still can.
--
-- Shifts closed more than 3 days before this runs count as already
-- approved (approved_at = closed_at, no approver), so the owner only reviews
-- the last few days instead of the whole history.

ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS approved_at timestamp;
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS approved_by_id varchar(36);
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS approved_by_name varchar(255);

UPDATE cash_shifts
   SET approved_at = closed_at
 WHERE status = 'closed'
   AND approved_at IS NULL
   AND closed_at < now() - interval '3 days';
