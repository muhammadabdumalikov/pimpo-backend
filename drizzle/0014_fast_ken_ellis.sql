ALTER TABLE "orders" ADD COLUMN "client_id" varchar(36);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unique_order_client_business" ON "orders" USING btree ("business_id","client_id");