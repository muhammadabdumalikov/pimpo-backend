-- Storefront step 4: an "old price" per product and an accent colour per shop.
--
-- Idempotent; additive only. Both columns are nullable with no default, so on
-- Postgres 11+ each ALTER is metadata-only (no rewrite of the large products
-- table) and every existing row reads as "not set" — nothing changes on the
-- storefront until the owner fills them in.
--
--   products.old_price      the price before a markdown, shown struck through
--                           next to price_out. The storefront shows it only
--                           while it is above price_out, so a later price
--                           change can never display a fake discount.
--   businesses.store_accent a key from the fixed storefront palette
--                           (src/common/store-accent.ts), never a free colour:
--                           every key was checked for contrast with white text.
--                           null = the default KPOS colour.

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "old_price" numeric(10, 2);

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "store_accent" varchar(16);
