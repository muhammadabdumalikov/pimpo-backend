-- Let a shop turn the barcode itself off on the shelf label.
--
-- `show_barcode_text` already controlled the digits UNDER the bars; there was
-- no way to drop the bars. A shop that prints price tags for goods it never
-- scans (loose produce, bakery, anything sold by weight off a scale label)
-- wants the name and the price on a small sticker and nothing else — the bars
-- just eat the millimetres it does not have.
--
-- Defaults to true so every existing row keeps printing exactly what it prints
-- today; only a shop that turns it off sees a change.
ALTER TABLE "label_settings"
  ADD COLUMN IF NOT EXISTS "show_barcode" boolean NOT NULL DEFAULT true;
