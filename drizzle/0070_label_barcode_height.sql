-- Shorter bars on shelf labels by default: 12 mm -> 8 mm.
--
-- On the default 58x40 stock, 12 mm of bars (plus the digits under them) took
-- about a third of the printable height, which left the product name and the
-- shop's name squeezed into what was left. 8 mm still scans reliably with a
-- handheld scanner at the till, and the space goes to the text.
ALTER TABLE "label_settings"
  ALTER COLUMN "barcode_height_mm" SET DEFAULT 8;

-- Shops that never changed the height are still on the old default; move them
-- with it. A shop that picked its own value keeps it — there is no telling a
-- deliberate 12 from an untouched one, so a shop that wants 12 back sets it
-- once in Sozlamalar -> Etiketka.
UPDATE "label_settings"
SET "barcode_height_mm" = 8
WHERE "barcode_height_mm" = 12;
