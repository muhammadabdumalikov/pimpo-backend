CREATE TABLE IF NOT EXISTS "ai_settings" (
	"business_id" varchar(36) PRIMARY KEY NOT NULL,
	"provider" varchar(20) NOT NULL,
	"model" varchar(60) NOT NULL,
	"api_key_cipher" text,
	"api_key_last4" varchar(8),
	"enabled" boolean DEFAULT false NOT NULL,
	"monthly_count" integer DEFAULT 0 NOT NULL,
	"monthly_period" varchar(7),
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
