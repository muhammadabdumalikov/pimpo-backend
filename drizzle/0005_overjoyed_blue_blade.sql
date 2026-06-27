ALTER TABLE "orders" ADD COLUMN "tax_rate" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "receipt_settings" ADD COLUMN "vat_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_settings" ADD COLUMN "vat_rate" numeric(5, 2) DEFAULT '12' NOT NULL;