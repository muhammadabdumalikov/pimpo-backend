ALTER TABLE "orders" ADD COLUMN "payments" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "amount_paid" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "change_amount" numeric(12, 2);