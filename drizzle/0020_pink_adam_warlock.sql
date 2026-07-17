CREATE TABLE IF NOT EXISTS "supplier_payments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"receipt_id" varchar(36) NOT NULL,
	"supplier_id" varchar(36),
	"supplier_name" varchar(255),
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'UZS' NOT NULL,
	"account_id" varchar(36),
	"account_name" varchar(255),
	"financial_transaction_id" varchar(36),
	"note" varchar(500),
	"cashier_id" varchar(36),
	"cashier_name" varchar(255),
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "paid_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "payment_status" varchar(10) DEFAULT 'unpaid' NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "currency" varchar(3) DEFAULT 'UZS' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
