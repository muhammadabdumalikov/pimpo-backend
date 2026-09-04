-- One-off data fix, not a schema migration. Safe to run before or after
-- 0064_product_mxik.sql — it touches neither of the new columns.
--
-- The barcode lookup used to copy the classifier name verbatim into
-- products.name, so a handful of catalogs hold rows literally named
-- "Газланган сув: Chortoq, шифобахш шиша бутилка 0,33 л." — where
-- "Газланган сув" is the classifier's own class, not part of the product name.
-- The read path stopped doing this (see common/mxik-name.ts); this repairs the
-- rows already written.
--
-- Only strips when the prefix is a REAL classifier class name. A shop's own
-- "ATVYORKA NABOR AFIXS NO: 3013" also contains ": " but its prefix matches no
-- classifier row, so it is left alone — a blind split would corrupt it.
--
-- Idempotent: once stripped, the name no longer contains ": ", so re-running
-- matches nothing. Preview first with the SELECT at the bottom.

WITH prefixes AS (
  SELECT DISTINCT split_part(name, ': ', 1) AS prefix
  FROM mxik_classifier
  WHERE name LIKE '%: %'
)
UPDATE products p
SET name = trim(substring(p.name FROM position(': ' IN p.name) + 2)),
    updated_at = now()
FROM prefixes x
WHERE p.name LIKE '%: %'
  AND split_part(p.name, ': ', 1) = x.prefix
  -- Mirror mxikDisplayName's guard: never leave a name too short to mean
  -- anything. Keeps the full string instead.
  AND length(trim(substring(p.name FROM position(': ' IN p.name) + 2))) >= 3;

-- Preview (run on its own before the UPDATE):
--
-- WITH prefixes AS (
--   SELECT DISTINCT split_part(name, ': ', 1) AS prefix
--   FROM mxik_classifier WHERE name LIKE '%: %'
-- )
-- SELECT p.id, p.name AS hozir,
--        trim(substring(p.name FROM position(': ' IN p.name) + 2)) AS keyin
-- FROM products p
-- JOIN prefixes x ON split_part(p.name, ': ', 1) = x.prefix
-- WHERE p.name LIKE '%: %'
--   AND length(trim(substring(p.name FROM position(': ' IN p.name) + 2))) >= 3;
