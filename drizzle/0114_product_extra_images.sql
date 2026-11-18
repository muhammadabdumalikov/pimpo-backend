-- Product gallery: a card can carry up to 7 photos besides its main one, so an
-- online shop can show an item from every side (clothes, shoes).
--
-- Idempotent; additive only. products.image stays THE main photo that every
-- list, the till, receipts, the apps and the shared barcode catalog read; this
-- column holds only the ADDITIONAL photos, in order. The storefront product
-- page shows [image, ...extra_images] with blanks and repeats dropped.
--
-- products is large: a constant default makes this a metadata-only change on
-- Postgres 11+ (no table rewrite, no backfill) — existing rows read as '[]'.
--
--   extra_images   jsonb array of photo URLs (each ≤ 500 chars, like image)

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "extra_images" jsonb DEFAULT '[]'::jsonb NOT NULL;
