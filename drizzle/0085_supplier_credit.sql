-- Defective goods back to a supplier without a receipt debt to take it off:
-- as a credit the supplier owes us, or as cash they hand back. Plus undoing a
-- defective supplier return. See YOQOTISHLAR.md S15–S26.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why: a defective return could only go off a receipt that still carried
-- debt, so a shop that pays its suppliers on delivery could never send
-- defective goods back through the system — only swap them. Agents usually
-- "take it off the next order" (a credit) or, now and then, hand the money
-- back.

-- supplier_returns: a return is no longer always tied to a receipt.
--   settlement     'debt' (off receipt_id's debt, as before) | 'credit' | 'cash'
--   computed_total what the system priced it at, when the person typed another
--                  total (credit / cash only; null = not edited)
--   usd_rate       for a USD credit / cash return: the rate its price was
--                  booked at (a debt return reads its receipt's)
--   branch_id      the branch the goods left (a debt return also has its
--                  receipt's)
--   finance_tx_id  cash: the kirim booked in Moliya, reversed on cancel
--   cancelled_at   undone: goods back in defective stock, debt / credit /
--                  cash reversed. The row stays for the audit trail and every
--                  report skips it.
ALTER TABLE "supplier_returns" ALTER COLUMN "receipt_id" DROP NOT NULL;
ALTER TABLE "supplier_returns" ADD COLUMN IF NOT EXISTS "settlement" varchar(8) DEFAULT 'debt' NOT NULL;
ALTER TABLE "supplier_returns" ADD COLUMN IF NOT EXISTS "computed_total" numeric(14, 2);
ALTER TABLE "supplier_returns" ADD COLUMN IF NOT EXISTS "usd_rate" numeric(12, 4);
ALTER TABLE "supplier_returns" ADD COLUMN IF NOT EXISTS "branch_id" varchar(36);
ALTER TABLE "supplier_returns" ADD COLUMN IF NOT EXISTS "finance_tx_id" varchar(36);
ALTER TABLE "supplier_returns" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp;
ALTER TABLE "supplier_returns" ADD COLUMN IF NOT EXISTS "cancelled_by_name" varchar(255);

-- The supplier's credit with us, as a ledger: the balance per currency is the
-- sum. kind: 'return' (+, a credit return) | 'return_cancel' (−) |
-- 'payment' (−, spent on a receipt) | 'payment_cancel' (+).
CREATE TABLE IF NOT EXISTS "supplier_credits" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "supplier_id" varchar(36) NOT NULL,
  "currency" varchar(3) NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "supplier_return_id" varchar(36),
  "supplier_payment_id" varchar(36),
  "receipt_id" varchar(36),
  "note" varchar(500),
  "cashier_id" varchar(36),
  "cashier_name" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "supplier_credits_supplier_idx"
  ON "supplier_credits" ("business_id", "supplier_id", "currency");

-- supplier_payments.source: 'money' (from a shop account / Tashqi mablag', as
-- before) | 'credit' (spent the supplier's credit; no Moliya row).
ALTER TABLE "supplier_payments" ADD COLUMN IF NOT EXISTS "source" varchar(8) DEFAULT 'money' NOT NULL;

-- defective_movements: an out_supplier move says how it was settled, and is
-- marked when its supplier return is undone (reports then skip it).
ALTER TABLE "defective_movements" ADD COLUMN IF NOT EXISTS "settlement" varchar(8);
ALTER TABLE "defective_movements" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp;
UPDATE "defective_movements" SET "settlement" = 'debt'
  WHERE "type" = 'out_supplier' AND "settlement" IS NULL;
