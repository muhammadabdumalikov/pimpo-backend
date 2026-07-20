CREATE TABLE IF NOT EXISTS "branch_stock" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"branch_id" varchar(36) NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD COLUMN "branch_id" varchar(36);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_stock" ADD CONSTRAINT "branch_stock_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branch_stock_product_branch_uq" ON "branch_stock" USING btree ("product_id","branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_stock_business_branch_idx" ON "branch_stock" USING btree ("business_id","branch_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill: each product currently belongs to one branch (products.branch_id),
-- so its whole on-hand quantity seeds that branch's stock row.
INSERT INTO "branch_stock" ("id", "business_id", "product_id", "branch_id", "quantity")
SELECT gen_random_uuid()::text, p."business_id", p."id", p."branch_id", p."quantity"
FROM "products" p
WHERE p."branch_id" IS NOT NULL
ON CONFLICT ("product_id","branch_id") DO NOTHING;
--> statement-breakpoint
-- Tag every existing batch with its product's branch so per-branch FIFO/COGS
-- draws from the right store's lots.
UPDATE "inventory_batches" ib
SET "branch_id" = p."branch_id"
FROM "products" p
WHERE ib."product_id" = p."id"
  AND ib."branch_id" IS NULL
  AND p."branch_id" IS NOT NULL;
