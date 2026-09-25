-- Reason codes for goods that leave stock or come back: write-offs, supplier
-- returns and customer returns. Feeds the "Qaytarish va yo'qotishlar" report.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why: every one of these flows stored its "why" as free text (or not at all,
-- for supplier returns), so the owner could not answer "how much did we lose
-- to theft this month" — one cashier typed "brak", another "yaroqsiz", a third
-- nothing. Each flow now stores a fixed code (common/loss-reasons.ts) next to
-- the free-text note it already had.
--
-- Codes are plain varchar, like stock_takes.type: the allowed values live in
-- the backend DTOs, not in a CHECK, so adding a code needs no migration.

-- ── Write-offs (stock_take_items of a 'writeoff' stock_take) ───────────────
-- reason stays the free-text note; reason_code is new.
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "reason_code" varchar(20);
-- The branch the write-off drew stock from. Nothing recorded it, so the report
-- couldn't filter write-offs by branch. Count lines leave it null (their branch
-- is stock_takes.store_id).
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "branch_id" varchar(36);

-- Backfill past write-offs from the product's home branch — the branch
-- writeOff() drew them from — else the business default branch (a product with
-- no home branch was drawn from the default one too).
UPDATE "stock_take_items" sti
SET "branch_id" = COALESCE(
  p."branch_id",
  (SELECT b."id" FROM "branches" b
    WHERE b."business_id" = sti."business_id" AND b."is_default" = true
    LIMIT 1)
)
FROM "stock_takes" st, "products" p
WHERE sti."stock_take_id" = st."id"
  AND st."type" = 'writeoff'
  AND sti."branch_id" IS NULL
  AND p."id" = sti."product_id";

-- A write-off line whose product was since deleted: default branch.
UPDATE "stock_take_items" sti
SET "branch_id" = (
  SELECT b."id" FROM "branches" b
  WHERE b."business_id" = sti."business_id" AND b."is_default" = true
  LIMIT 1
)
FROM "stock_takes" st
WHERE sti."stock_take_id" = st."id"
  AND st."type" = 'writeoff'
  AND sti."branch_id" IS NULL;

-- Past free-text write-off reasons are NOT guessed into codes: they stay as the
-- note and the report shows them as "unspecified".

-- ── Supplier returns ───────────────────────────────────────────────────────
ALTER TABLE "supplier_return_items" ADD COLUMN IF NOT EXISTS "reason_code" varchar(20);
ALTER TABLE "supplier_return_items" ADD COLUMN IF NOT EXISTS "note" varchar(255);

-- ── Customer returns ───────────────────────────────────────────────────────
ALTER TABLE "sale_returns" ADD COLUMN IF NOT EXISTS "reason_code" varchar(20);

-- The till's quick-reason chips wrote their label, in the cashier's UI
-- language, into the free-text reason. Those labels are known exactly (they
-- have never changed), so a reason that is exactly one of them becomes its
-- code. Matched on the exact label (case included — lower() doesn't fold
-- Cyrillic under a C collation); anything else, typed or edited, stays
-- unspecified. The text itself is kept as the note either way.
UPDATE "sale_returns"
SET "reason_code" = CASE btrim("reason")
  WHEN 'Nuqsonli'                    THEN 'defective'
  WHEN 'Нуқсонли'                    THEN 'defective'
  WHEN 'С дефектом'                  THEN 'defective'
  WHEN 'Faulty'                      THEN 'defective'
  WHEN 'Mijoz fikrini o''zgartirdi'  THEN 'changed_mind'
  WHEN 'Мижоз фикрини ўзгартирди'    THEN 'changed_mind'
  WHEN 'Клиент передумал'            THEN 'changed_mind'
  WHEN 'Changed their mind'          THEN 'changed_mind'
  WHEN 'Noto''g''ri tovar'           THEN 'wrong_item'
  WHEN 'Нотўғри товар'               THEN 'wrong_item'
  WHEN 'Не тот товар'                THEN 'wrong_item'
  WHEN 'Wrong item'                  THEN 'wrong_item'
  WHEN 'Muddati o''tgan'             THEN 'expired'
  WHEN 'Муддати ўтган'               THEN 'expired'
  WHEN 'Истёк срок'                  THEN 'expired'
  WHEN 'Past its date'               THEN 'expired'
END
WHERE "reason_code" IS NULL
  AND "reason" IS NOT NULL;

-- Report lookups: the loss report reads each flow by business + date and
-- groups by code; the existing (business, created_at) indexes cover the range
-- scan, so no new index is needed.
