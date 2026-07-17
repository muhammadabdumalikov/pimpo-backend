ALTER TABLE "goods_receipt_items" ADD COLUMN "currency" varchar(3) DEFAULT 'UZS' NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "usd_rate" numeric(12, 4);