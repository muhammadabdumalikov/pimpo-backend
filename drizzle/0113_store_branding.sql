-- Storefront branding: a shop's online store gets a face — a logo, a cover
-- picture, a one-line tagline and its contact handles — set by the owner under
-- Settings → Online store and returned by the public GET /store/info.
--
-- Idempotent; additive only. Every column is nullable: a shop that never sets
-- them looks exactly as it does today.
--
--   store_tagline     one line under the shop name (max 140 chars)
--   store_instagram   Instagram username, bare (no "@", no URL)
--   store_telegram    Telegram username, bare
--   store_phone       public contact phone, "+998" and nine digits
--   store_logo        picture URL, uploaded like the store banners
--   store_cover       picture URL, uploaded like the store banners

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "store_tagline" varchar(140),
  ADD COLUMN IF NOT EXISTS "store_instagram" varchar(30),
  ADD COLUMN IF NOT EXISTS "store_telegram" varchar(32),
  ADD COLUMN IF NOT EXISTS "store_phone" varchar(32),
  ADD COLUMN IF NOT EXISTS "store_logo" varchar(500),
  ADD COLUMN IF NOT EXISTS "store_cover" varchar(500);
