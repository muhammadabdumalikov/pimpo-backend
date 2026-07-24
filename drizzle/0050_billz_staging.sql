ALTER TABLE "billz_import_jobs" ADD COLUMN IF NOT EXISTS "phase" varchar(8) DEFAULT 'fetch' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billz_staging" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"job_id" varchar(36) NOT NULL,
	"entity" varchar(16) NOT NULL,
	"billz_id" varchar(64),
	"payload" jsonb NOT NULL,
	"status" varchar(8) DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"loaded_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billz_staging" ADD CONSTRAINT "billz_staging_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billz_staging" ADD CONSTRAINT "billz_staging_job_id_billz_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."billz_import_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billz_staging_job_entity_status_idx" ON "billz_staging" ("job_id","entity","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billz_staging_business_entity_idx" ON "billz_staging" ("business_id","entity");
