CREATE TABLE IF NOT EXISTS "stock_transfer_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"transfer_id" varchar(36) NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"product_id" varchar(36),
	"product_name" varchar(255) NOT NULL,
	"quantity" double precision NOT NULL,
	"unit_cost" numeric(10, 2),
	"line_total" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"from_branch_id" varchar(36) NOT NULL,
	"from_branch_name" varchar(255),
	"to_branch_id" varchar(36) NOT NULL,
	"to_branch_name" varchar(255),
	"status" varchar(12) DEFAULT 'completed' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"total_qty" numeric(14, 3) DEFAULT '0' NOT NULL,
	"total_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_by_cashier_id" varchar(36),
	"created_by_cashier_name" varchar(255),
	"note" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfer_items_transfer_idx" ON "stock_transfer_items" USING btree ("transfer_id");