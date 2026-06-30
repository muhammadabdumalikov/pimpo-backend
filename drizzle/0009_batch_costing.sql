CREATE TABLE IF NOT EXISTS "inventory_batches" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"receipt_item_id" varchar(36),
	"price_in" numeric(10, 2) NOT NULL,
	"price_out" numeric(10, 2) NOT NULL,
	"qty_received" integer NOT NULL,
	"qty_remaining" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "cost_in" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "cost_total" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_settings" ADD COLUMN "costing_method" varchar(10) DEFAULT 'AVERAGE' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_settings" ADD COLUMN "price_increase_mode" varchar(20) DEFAULT 'KEEP_OLD' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_receipt_item_id_goods_receipt_items_id_fk" FOREIGN KEY ("receipt_item_id") REFERENCES "public"."goods_receipt_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_batches_open_idx" ON "inventory_batches" USING btree ("business_id","product_id","qty_remaining");--> statement-breakpoint
-- Backfill: seed one opening batch per in-stock product from its current
-- quantity / cost / selling price, so existing inventory has a cost basis and
-- the FIFO queue is non-empty. Past consumed receipts are not reconstructed.
INSERT INTO "inventory_batches"
  ("id", "business_id", "product_id", "receipt_item_id", "price_in", "price_out", "qty_received", "qty_remaining", "created_at")
SELECT
  gen_random_uuid()::text, "business_id", "id", NULL, "price_in", "price_out", "quantity", "quantity", now()
FROM "products"
WHERE "quantity" > 0;