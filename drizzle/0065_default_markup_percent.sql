-- House markup (marja) over cost, in percent: one number per business that
-- pre-fills the selling price on every new product and receipt line, so a shop
-- that always sells at +25% types the cost only. NULL = no house rule, which is
-- the state every existing business starts in (prices stay hand-typed).
ALTER TABLE "receipt_settings"
  ADD COLUMN IF NOT EXISTS "default_markup_percent" numeric(6, 2);
