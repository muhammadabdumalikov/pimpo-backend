-- Repair: 0079's data part, on a database where only its columns arrived.
--
-- Idempotent; safe to re-run. Needs 0079's columns (`source`, `is_capital`,
-- `reverses_id`, `cancelled_at`); no backend deploy depends on it.
--
-- Found on prod 2026-10-02: the columns were there, but none of 0079's data
-- work had run. The capital categories were never flagged, so "Inkassatsiya"
-- counted as a P&L expense and a "Tashqi investitsiya" kirim would count as
-- profit. No business had "Boshlang'ich qoldiq". Rows written before the
-- backend deploy (~2026-09-24) were still `source = 'manual'`, supplier
-- payments included, so the P&L kept subtracting them on top of COGS.
--
-- Re-running 0079 itself would not fix the flags: its capital seeding only
-- fires when the `is_capital` column is first added.

-- ── Capital flags, for businesses 0079 never reached ────────────────────────
-- Any business 0079 reached has "Boshlang'ich qoldiq": 0079 inserts it, and
-- the backend seeds it for every shop it creates. A business without it never
-- got 0079's capital seeding either, so the flags are set here. The insert
-- right after is the marker. A re-run finds "Boshlang'ich qoldiq" and leaves
-- the flags alone, so an owner's later choice on the Toifalar page stands.
UPDATE "financial_categories" AS c
SET "is_capital" = true
WHERE c.is_capital = false
  AND ((c.kind = 'income' AND c.name = 'Tashqi investitsiya')
       OR (c.kind = 'expense' AND c.name = 'Inkassatsiya'))
  AND NOT EXISTS (
    SELECT 1 FROM "financial_categories" o
    WHERE o.business_id = c.business_id
      AND o.kind = 'income'
      AND o.name = 'Boshlang''ich qoldiq'
  );

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

-- ── Backfill `source` (unchanged from 0079; only rows still at the default) ─
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

UPDATE "financial_transactions" SET "source" = 'supplier_payment'
WHERE "source" = 'manual'
  AND kind = 'expense'
  AND category_id IS NULL
  AND note LIKE 'Ta''minotchi to''lovi%';

UPDATE "financial_transactions" SET "source" = 'reversal'
WHERE "source" = 'manual'
  AND kind = 'income'
  AND (note LIKE 'Bekor qilindi: ta''minotchi to''lovi%'
       OR note LIKE 'Bekor qilindi: % — ish haqi to''lovi');

-- Match each old reversal to the expense it answered (unchanged from 0079).
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

-- Read-only checks, run on their own afterwards — each should return no rows:
--
-- SELECT business_id, name, is_capital FROM financial_categories
-- WHERE name IN ('Tashqi investitsiya', 'Inkassatsiya') AND is_capital = false;
--
-- SELECT ft.id FROM financial_transactions ft
-- JOIN supplier_payments sp ON sp.financial_transaction_id = ft.id
-- WHERE ft.source <> 'supplier_payment';
--
-- SELECT id, business_id, amount, note FROM financial_transactions
-- WHERE source = 'reversal' AND reverses_id IS NULL;
