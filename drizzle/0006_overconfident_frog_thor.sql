ALTER TABLE "user_debts" ADD COLUMN "order_id" varchar(36);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_debts" ADD CONSTRAINT "user_debts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
