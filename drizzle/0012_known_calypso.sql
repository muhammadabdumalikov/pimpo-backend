ALTER TABLE "orders" ADD COLUMN "subtotal_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_type" varchar(10);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_value" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_amount" numeric(12, 2) DEFAULT '0' NOT NULL;