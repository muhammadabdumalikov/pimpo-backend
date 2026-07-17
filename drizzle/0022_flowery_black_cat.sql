CREATE TABLE IF NOT EXISTS "supplier_return_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"return_id" varchar(36) NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"product_id" varchar(36),
	"product_name" varchar(255) NOT NULL,
	"price_in" numeric(10, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_returns" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"receipt_id" varchar(36) NOT NULL,
	"supplier_id" varchar(36),
	"supplier_name" varchar(255),
	"total_amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'UZS' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"note" varchar(500),
	"cashier_id" varchar(36),
	"cashier_name" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "returned_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_return_id_supplier_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."supplier_returns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
