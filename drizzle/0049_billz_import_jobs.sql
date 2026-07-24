CREATE TABLE IF NOT EXISTS "billz_import_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"entities" jsonb NOT NULL,
	"current_entity" varchar(16),
	"counters" jsonb NOT NULL,
	"checkpoint" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billz_import_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"job_id" varchar(36) NOT NULL,
	"entity" varchar(16) NOT NULL,
	"billz_id" varchar(64),
	"name" text,
	"status" varchar(8) NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billz_import_jobs" ADD CONSTRAINT "billz_import_jobs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billz_import_items" ADD CONSTRAINT "billz_import_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billz_import_items" ADD CONSTRAINT "billz_import_items_job_id_billz_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."billz_import_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billz_import_jobs_business_created_idx" ON "billz_import_jobs" ("business_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billz_import_jobs_status_idx" ON "billz_import_jobs" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billz_import_items_business_entity_created_idx" ON "billz_import_items" ("business_id","entity","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billz_import_items_job_idx" ON "billz_import_items" ("job_id");
