CREATE TABLE IF NOT EXISTS "loyalty_settings" (
	"business_id" varchar(36) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cashback_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"min_purchase" numeric(12, 2) DEFAULT '0' NOT NULL,
	"redeem_max_percent" numeric(5, 2) DEFAULT '50' NOT NULL,
	"expiry_months" integer,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
