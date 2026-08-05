CREATE TABLE IF NOT EXISTS "payroll_settings" (
	"business_id" varchar(36) PRIMARY KEY NOT NULL,
	"auto_accrue" boolean DEFAULT false NOT NULL,
	"last_auto_period" varchar(7),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
