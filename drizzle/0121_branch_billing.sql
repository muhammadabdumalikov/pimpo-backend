-- Per-store billing on one shared balance (FILIAL-OBUNA.md).
--
-- Idempotent; safe to re-run.
--
-- An extra store is free for its first 3 days, then its share of the period
-- is taken from the shared balance; unpaid, it warns for 3 days and closes.
-- A closed store is read-only: the trigger below refuses every change of its
-- stock (sale, receipt, transfer, count), whichever code path writes it.

ALTER TABLE branches ADD COLUMN IF NOT EXISTS free_until timestamptz;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS paid_until timestamptz;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS renew boolean DEFAULT true NOT NULL;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS billing_closed_at timestamptz;

-- Stores open today were charged when they opened (paid_extra_branches), so
-- they are paid through the running period.
UPDATE branches b
SET paid_until = s.end_date
FROM business_subscriptions s
WHERE s.business_id = b.business_id
  AND s.is_active
  AND s.end_date IS NOT NULL
  AND b.is_active
  AND NOT b.is_default
  AND b.paid_until IS NULL;

CREATE OR REPLACE FUNCTION branch_stock_closed_guard() RETURNS trigger AS $$
BEGIN
  -- Only a real change of the quantity counts: the zero rows a new product
  -- card gets in every store, and rewrites to the same value, pass.
  IF TG_OP = 'UPDATE' AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND COALESCE(NEW.quantity, 0) = 0 THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM branches
    WHERE id = NEW.branch_id AND billing_closed_at IS NOT NULL
  ) THEN
    -- The API maps this message to BRANCH_CLOSED (common/errors/db-errors.ts).
    RAISE EXCEPTION 'BRANCH_CLOSED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS branch_stock_closed_guard ON branch_stock;
CREATE TRIGGER branch_stock_closed_guard
  BEFORE INSERT OR UPDATE ON branch_stock
  FOR EACH ROW EXECUTE FUNCTION branch_stock_closed_guard();
