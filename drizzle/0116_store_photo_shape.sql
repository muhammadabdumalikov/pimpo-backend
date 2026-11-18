-- Storefront step 5: a product photo shape per shop.
--
-- Idempotent; additive only. The column is nullable with no default, so on
-- Postgres 11+ the ALTER is metadata-only and every existing shop reads as
-- "not set" — the storefront keeps today's square cards until the owner
-- changes it.
--
--   businesses.store_photo_shape  how product cards are drawn on the
--                                 storefront (src/common/store-photo-shape.ts):
--                                 'portrait' = 4:5 (clothes shops), null =
--                                 square, the default. 'square' is never
--                                 stored; it is written as null.

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "store_photo_shape" varchar(8);
