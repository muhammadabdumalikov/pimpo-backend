CREATE TABLE IF NOT EXISTS "telegram_notification_settings" (
	"business_id" varchar(36) PRIMARY KEY NOT NULL,
	"checkout" boolean DEFAULT false NOT NULL,
	"cash_shifts" boolean DEFAULT false NOT NULL,
	"cash_operations" boolean DEFAULT false NOT NULL,
	"daily_sales" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_notification_settings" ADD CONSTRAINT "telegram_notification_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
