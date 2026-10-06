-- "Navbatdagi narx": a delivery's lower selling price waits until the stock
-- that came in before it has sold out in every branch, then moves the card
-- once. Rises still go onto the card at once.
--
-- Idempotent; safe to re-run. Additive only — the running code ignores all of it.
--
--   product_price_steps                    the waiting prices, one row per
--                                          product + field + delivery.
--   receipt_settings.defer_price_drops     the shop's switch (default ON).
--   product_price_history.reason           why a waiting price was dropped
--                                          (rows sourced 'queue_cancel').
--   telegram_notification_settings
--     .price_changes                       Telegram/push when a waiting price
--                                          took effect (default ON).
ALTER TABLE "receipt_settings" ADD COLUMN IF NOT EXISTS "defer_price_drops" boolean DEFAULT true NOT NULL;
ALTER TABLE "product_price_history" ADD COLUMN IF NOT EXISTS "reason" varchar(20);
ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "price_changes" boolean DEFAULT true NOT NULL;

CREATE TABLE IF NOT EXISTS "product_price_steps" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "product_id" varchar(36) NOT NULL,
  "field" varchar(20) NOT NULL,
  "price" numeric(10, 2) NOT NULL,
  "receipt_id" varchar(36) NOT NULL,
  "trigger_at" timestamp NOT NULL,
  "cashier_id" varchar(36),
  "cashier_name" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "product_price_steps" ADD CONSTRAINT "product_price_steps_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "product_price_steps" ADD CONSTRAINT "product_price_steps_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "product_price_steps" ADD CONSTRAINT "product_price_steps_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "product_price_steps_product_idx" ON "product_price_steps" USING btree ("business_id","product_id","field","trigger_at");
CREATE INDEX IF NOT EXISTS "product_price_steps_receipt_idx" ON "product_price_steps" USING btree ("receipt_id");
