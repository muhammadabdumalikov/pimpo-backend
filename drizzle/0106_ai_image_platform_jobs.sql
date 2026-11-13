-- AI images ordered from the platform console (AI-RASM.md "Platformadan
-- ommaviy"): the console picks a shop's best-selling imageless products and
-- has packshots made for them in the background, paid from the platform's
-- budget instead of the shop's allowance.
--
-- Idempotent; safe to re-run. Additive only — the old code never reads the new
-- column (its default keeps every existing row a shop call) or the new table.
--
--   ai_image_generations.initiator   'shop' | 'platform' — who ordered the call;
--                                    the shop allowance sums only 'shop' rows,
--                                    the platform budget sums all of them
--   ai_image_jobs                    one queued picture per product: queued →
--                                    running → ready → applied | rejected,
--                                    or failed / cancelled

ALTER TABLE "ai_image_generations"
  ADD COLUMN IF NOT EXISTS "initiator" varchar(10) DEFAULT 'shop' NOT NULL;

CREATE TABLE IF NOT EXISTS "ai_image_jobs" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "product_id" varchar(36) NOT NULL,
  "status" varchar(12) NOT NULL,
  "description" text,
  "generation_id" varchar(36),
  "image_url" varchar(500),
  "fail_reason" varchar(40),
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "decided_at" timestamp
);
DO $$ BEGIN
 ALTER TABLE "ai_image_jobs" ADD CONSTRAINT "ai_image_jobs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "ai_image_jobs_business_product_idx" ON "ai_image_jobs" USING btree ("business_id","product_id");
CREATE INDEX IF NOT EXISTS "ai_image_jobs_queued_idx" ON "ai_image_jobs" USING btree ("created_at") WHERE "ai_image_jobs"."status" IN ('queued', 'running');

-- Deny-by-default for the assistant's read-only role, like the rest of the
-- AI image tables (0095).
ALTER TABLE "ai_image_jobs" ENABLE ROW LEVEL SECURITY;
