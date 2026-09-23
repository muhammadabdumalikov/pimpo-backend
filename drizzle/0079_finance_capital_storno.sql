-- Moliya: kapital kirim, "Tashqi mablag'", storno, and the P&L fix.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend (the new code
-- writes `source` / `is_capital` and would fail without them).
--
-- What changes:
--  * financial_transactions gets `source` (who wrote the row), `reverses_id` +
--    `cancelled_at` (storno), `pair_id` (the two legs of a "Tashqi mablag'"
--    booking).
--  * financial_categories gets `is_capital`: capital money moves between the
--    owner and the shop and stays out of the P&L. "Tashqi investitsiya",
--    "Boshlang'ich qoldiq" and "Inkassatsiya" start out capital.
--  * One hidden 'external' account per business (partial unique index).
--
-- Backfill, so past P&Ls come out right too:
--  * every existing row gets its real `source`. Supplier payments were being
--    subtracted as expenses on top of COGS — marking them is what lets the
--    P&L drop them.
--  * the compensating incomes the old code wrote for a cancelled supplier
--    payment / undone wage become 'reversal' rows, matched back to the expense
--    they answered (that original gets `cancelled_at`), so neither counts.

-- ── Columns ─────────────────────────────────────────────────────────────────
ALTER TABLE "financial_transactions"
  ADD COLUMN IF NOT EXISTS "source" varchar(20) NOT NULL DEFAULT 'manual';
ALTER TABLE "financial_transactions"
  ADD COLUMN IF NOT EXISTS "reverses_id" varchar(36);
ALTER TABLE "financial_transactions"
  ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp;
ALTER TABLE "financial_transactions"
  ADD COLUMN IF NOT EXISTS "pair_id" varchar(36);

CREATE INDEX IF NOT EXISTS "financial_transactions_pair_idx"
  ON "financial_transactions" ("pair_id")
  WHERE "pair_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "accounts_business_external_uq"
  ON "accounts" ("business_id")
  WHERE "type" = 'external';

-- The capital flag is seeded only when the column is first added, so a re-run
-- never undoes an owner's own choice on the Toifalar page.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'financial_categories' AND column_name = 'is_capital'
  ) THEN
    ALTER TABLE "financial_categories"
      ADD COLUMN "is_capital" boolean NOT NULL DEFAULT false;
    UPDATE "financial_categories"
    SET "is_capital" = true
    WHERE (kind = 'income' AND name IN ('Tashqi investitsiya', 'Boshlang''ich qoldiq'))
       OR (kind = 'expense' AND name = 'Inkassatsiya');
  END IF;
END $$;

-- "Boshlang'ich qoldiq" for every business that already has categories (new
-- businesses get it from the backend's defaults).
INSERT INTO "financial_categories"
  ("id", "business_id", "name", "kind", "is_capital", "is_active", "created_at")
SELECT gen_random_uuid()::text, b.business_id, 'Boshlang''ich qoldiq', 'income', true, true, now()
FROM (SELECT DISTINCT business_id FROM "financial_categories") AS b
WHERE NOT EXISTS (
  SELECT 1 FROM "financial_categories" c
  WHERE c.business_id = b.business_id
    AND c.kind = 'income'
    AND c.name = 'Boshlang''ich qoldiq'
);

-- ── Backfill `source` (only rows still at the default) ─────────────────────
UPDATE "financial_transactions" SET "source" = 'shift_close'
WHERE "source" = 'manual' AND kind = 'shift_close';

UPDATE "financial_transactions" SET "source" = 'cash_movement'
WHERE "source" = 'manual' AND cash_movement_id IS NOT NULL;

UPDATE "financial_transactions" AS ft SET "source" = 'supplier_payment'
FROM "supplier_payments" AS sp
WHERE ft."source" = 'manual' AND sp.financial_transaction_id = ft.id;

UPDATE "financial_transactions" AS ft SET "source" = 'payroll'
FROM "payroll_entries" AS pe
WHERE ft."source" = 'manual' AND pe.financial_transaction_id = ft.id;

UPDATE "financial_transactions" SET "source" = 'stock_take'
WHERE "source" = 'manual'
  AND account_id IS NULL
  AND category_id IS NULL
  AND category_name IN ('Inventarizatsiya ortiqchasi', 'Inventarizatsiya kamomadi', 'Hisobdan chiqarish');

-- Supplier payments cancelled before this migration: their payment row is
-- gone, but the expense still carries the default note.
UPDATE "financial_transactions" SET "source" = 'supplier_payment'
WHERE "source" = 'manual'
  AND kind = 'expense'
  AND category_id IS NULL
  AND note LIKE 'Ta''minotchi to''lovi%';

-- The old compensating incomes. Their notes were always system-written.
UPDATE "financial_transactions" SET "source" = 'reversal'
WHERE "source" = 'manual'
  AND kind = 'income'
  AND (note LIKE 'Bekor qilindi: ta''minotchi to''lovi%'
       OR note LIKE 'Bekor qilindi: % — ish haqi to''lovi');

-- Match each old reversal to the expense it answered: same account, currency
-- and amount, posted before it, not answered yet, and no longer backed by a
-- live payment / payroll entry. Latest candidate wins; oldest reversal first.
DO $$
DECLARE
  r record;
  o_id varchar(36);
  is_supplier boolean;
BEGIN
  FOR r IN
    SELECT * FROM "financial_transactions"
    WHERE "source" = 'reversal' AND reverses_id IS NULL
    ORDER BY created_at
  LOOP
    is_supplier := r.note LIKE 'Bekor qilindi: ta''minotchi to''lovi%';
    SELECT o.id INTO o_id
    FROM "financial_transactions" AS o
    WHERE o.business_id = r.business_id
      AND o.kind = 'expense'
      AND o.cancelled_at IS NULL
      AND o."source" <> 'reversal'
      AND o.account_id = r.account_id
      AND o.currency = r.currency
      AND o.amount = r.amount
      AND o.created_at <= r.created_at
      AND (
        (is_supplier
          AND o.category_id IS NULL
          AND o."source" IN ('manual', 'supplier_payment')
          AND NOT EXISTS (SELECT 1 FROM "supplier_payments" sp WHERE sp.financial_transaction_id = o.id))
        OR
        (NOT is_supplier
          AND o.category_name = r.category_name
          AND o."source" IN ('manual', 'payroll')
          AND NOT EXISTS (SELECT 1 FROM "payroll_entries" pe WHERE pe.financial_transaction_id = o.id))
      )
    ORDER BY o.created_at DESC
    LIMIT 1;

    IF o_id IS NOT NULL THEN
      UPDATE "financial_transactions"
      SET cancelled_at = r.created_at,
          "source" = CASE WHEN is_supplier THEN 'supplier_payment' ELSE 'payroll' END
      WHERE id = o_id;
      UPDATE "financial_transactions" SET reverses_id = o_id WHERE id = r.id;
    ELSE
      RAISE NOTICE 'Unmatched old reversal % (business %, amount %)', r.id, r.business_id, r.amount;
    END IF;
  END LOOP;
END $$;

-- Read-only check, run on its own afterwards — should return no rows:
--
-- SELECT id, business_id, amount, note FROM financial_transactions
-- WHERE source = 'reversal' AND reverses_id IS NULL;
