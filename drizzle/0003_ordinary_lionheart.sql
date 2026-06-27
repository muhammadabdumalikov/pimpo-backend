CREATE TABLE IF NOT EXISTS "receipt_settings" (
	"business_id" varchar(36) PRIMARY KEY NOT NULL,
	"receipt_name" varchar(255) DEFAULT 'Standart' NOT NULL,
	"show_logo" boolean DEFAULT true NOT NULL,
	"logo_url" varchar(500),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipt_settings" ADD CONSTRAINT "receipt_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
