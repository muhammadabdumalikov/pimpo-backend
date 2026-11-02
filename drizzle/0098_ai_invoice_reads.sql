-- Delivery-note scanner spend: one row per AI read, so the platform console can
-- report it over any date range.
--
-- Idempotent; safe to re-run. Additive only — a new table nothing running today
-- reads, so the old code keeps serving through the rollout. Earlier reads can't
-- be backfilled: only a monthly per-shop total, mixed with the assistant, exists.

CREATE TABLE IF NOT EXISTS "ai_invoice_reads" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "model" varchar(60) NOT NULL,
  "page_count" integer DEFAULT 0 NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "ai_invoice_reads" ADD CONSTRAINT "ai_invoice_reads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "ai_invoice_reads_business_created_idx" ON "ai_invoice_reads" USING btree ("business_id","created_at");
CREATE INDEX IF NOT EXISTS "ai_invoice_reads_created_idx" ON "ai_invoice_reads" USING btree ("created_at");

-- Deny-by-default for the assistant's read-only role, like every other table
-- (0062 §2). No policy and no grant: this is the console's accounting.
ALTER TABLE "ai_invoice_reads" ENABLE ROW LEVEL SECURITY;
