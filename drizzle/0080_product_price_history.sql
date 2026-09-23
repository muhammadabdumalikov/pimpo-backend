-- Who changed a selling price, when, and what it was before.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why: until now nothing recorded a price change, and the only trace of one was
-- products.updated_at — a single timestamp that any edit moves. When a shop
-- reported "the price changes by itself" the answer had to be reconstructed
-- from sale prices and deploy dates, which took an afternoon and still ended in
-- an inference. Selling prices are now only ever set by a person (the card, or
-- applying a delivery's prices to it), so a row per change answers that
-- question outright: this person, from this screen, at this time.
--
-- One row per FIELD changed, not per edit: a card whose retail and wholesale
-- prices move together writes two rows. That keeps "how did the wholesale price
-- get here" a single-column query rather than a comparison of two JSON blobs.
--
-- old_price is nullable because a tier can be set for the first time.

CREATE TABLE IF NOT EXISTS "product_price_history" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "product_id" varchar(36) NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  -- 'priceOut' | 'priceWholesale' | 'priceBundle'
  "field" varchar(20) NOT NULL,
  "old_price" numeric(10, 2),
  "new_price" numeric(10, 2) NOT NULL,
  -- Where the change came from: 'card' (product form) or 'receipt' (a delivery
  -- note's prices applied to the card). The receipt is kept so the row can be
  -- read back to the document it came from.
  "source" varchar(20) NOT NULL DEFAULT 'card',
  "receipt_id" varchar(36),
  "cashier_id" varchar(36),
  "cashier_name" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- "The price history of THIS product, newest first" — the only read there is.
CREATE INDEX IF NOT EXISTS "product_price_history_product_idx"
  ON "product_price_history" ("business_id", "product_id", "created_at" DESC);
