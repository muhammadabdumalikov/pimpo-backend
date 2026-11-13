-- "Boshlang'ich qoldiq" documents (FILIAL-ASSORTIMENT.md Q4/Q9): a counted,
-- add-only stock document for one branch, kept as a server-side draft while
-- the shop scans, then completed as capital-booked lots or as a transfer.
--
-- Idempotent; additive only — two new tables the running code never reads.

CREATE TABLE IF NOT EXISTS "opening_stocks" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "branch_id" varchar(36) NOT NULL,
  "branch_name" varchar(255),
  "source" varchar(12) NOT NULL,
  "from_branch_id" varchar(36),
  "from_branch_name" varchar(255),
  "status" varchar(12) DEFAULT 'draft' NOT NULL,
  "item_count" integer DEFAULT 0 NOT NULL,
  "total_qty" numeric(14, 3) DEFAULT '0' NOT NULL,
  "total_value" numeric(14, 2) DEFAULT '0' NOT NULL,
  "transfer_id" varchar(36),
  "created_by_cashier_id" varchar(36),
  "created_by_cashier_name" varchar(255),
  "note" varchar(500),
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "opening_stocks" ADD CONSTRAINT "opening_stocks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "opening_stocks" ADD CONSTRAINT "opening_stocks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "opening_stocks" ADD CONSTRAINT "opening_stocks_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "opening_stocks" ADD CONSTRAINT "opening_stocks_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "opening_stocks_business_created_idx" ON "opening_stocks" USING btree ("business_id","created_at");

CREATE TABLE IF NOT EXISTS "opening_stock_items" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "opening_stock_id" varchar(36) NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "product_id" varchar(36) NOT NULL,
  "product_name" varchar(255) NOT NULL,
  "quantity" double precision NOT NULL,
  "unit_cost" numeric(10, 2),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "opening_stock_items" ADD CONSTRAINT "opening_stock_items_opening_stock_id_opening_stocks_id_fk" FOREIGN KEY ("opening_stock_id") REFERENCES "public"."opening_stocks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "opening_stock_items" ADD CONSTRAINT "opening_stock_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "opening_stock_items_doc_product_uq" ON "opening_stock_items" USING btree ("opening_stock_id","product_id");

-- Not in the AI assistant's table allowlist: RLS on, no ai_ro_tenant policy.
ALTER TABLE "opening_stocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opening_stock_items" ENABLE ROW LEVEL SECURITY;
