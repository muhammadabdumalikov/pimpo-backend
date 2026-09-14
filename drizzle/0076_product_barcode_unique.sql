-- One barcode, one card — within a shop.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why: nothing stopped a second card carrying a barcode the shop already used,
-- and a shop that had one found out the hard way. Every scan after that is a
-- coin toss — the till, the label and the stock each take whichever row the
-- query returns first — and it is also how the same delivery gets typed twice:
-- a card that "didn't appear" on the nakladnoy is made again under the same
-- barcode, the goods land on one of the two, and the other sits at zero
-- forever. ProductService now refuses the second one (PRODUCT_BARCODE_EXISTS);
-- this index is the backstop for races and for anything writing SQL directly.
--
-- Scope of the rule:
--   * per business — two shops sharing a real EAN is normal and expected;
--   * ACTIVE cards only — a deleted card must not keep a barcode out of
--     circulation;
--   * a blank barcode is not a barcode and never clashes.
--
-- A product sold both loose and by the box needs its own barcode on each card
-- (or none on the second) — the printed EAN can only point at one of them.
--
-- CONCURRENTLY: products is written to while the shop is open. It cannot run
-- inside a transaction block — run this file with psql (autocommit), not
-- inside BEGIN/COMMIT. An interrupted build leaves an INVALID index behind:
-- DROP INDEX it and re-run.

-- Refuse to start while the shop still has collisions: CREATE UNIQUE INDEX
-- CONCURRENTLY would fail halfway and leave an invalid index, and its own
-- message names only one offending key. This names them all, so the cleanup
-- (tekshiruv-0-qoldiq.sql picks them out) can be finished first.
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(
           format('%s → %s cards', barcode, n),
           E'\n  ' ORDER BY n DESC, barcode
         )
    INTO collisions
    FROM (
      SELECT barcode, count(*) AS n
        FROM products
       WHERE is_active
         AND barcode IS NOT NULL
         AND barcode <> ''
       GROUP BY business_id, barcode
      HAVING count(*) > 1
    ) dup;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION
      E'Duplicate barcodes still present — clean them up before adding the unique index:\n  %',
      collisions;
  END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "products_business_barcode_uq"
  ON "products" ("business_id", "barcode")
  WHERE "is_active" AND "barcode" IS NOT NULL AND "barcode" <> '';
