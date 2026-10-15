-- AI product images (AI-RASM.md): packshots made on Pimpo's own Gemini key.
--
-- Idempotent; safe to re-run. Additive only — two new tables nothing running
-- today reads, so the old code keeps serving through the rollout.
--
--   ai_image_generations   every paid call (describe + image), the spend ledger
--                          the shop allowance and the platform budget sum over
--   ai_image_quotas        a shop's allowance when the console moved it off the
--                          default; no row = the default

CREATE TABLE IF NOT EXISTS "ai_image_generations" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "account_id" varchar(36) NOT NULL,
  "product_id" varchar(36),
  "kind" varchar(10) NOT NULL,
  "mode" varchar(10) NOT NULL,
  "model" varchar(60) NOT NULL,
  "description" text,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "status" varchar(10) NOT NULL,
  "fail_reason" varchar(40),
  "image_key" varchar(500),
  "image_url" varchar(500),
  "accepted_at" timestamp,
  "purged_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "ai_image_generations" ADD CONSTRAINT "ai_image_generations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "ai_image_generations_business_created_idx" ON "ai_image_generations" USING btree ("business_id","created_at");
CREATE INDEX IF NOT EXISTS "ai_image_generations_created_idx" ON "ai_image_generations" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "ai_image_generations_business_url_idx" ON "ai_image_generations" USING btree ("business_id","image_url") WHERE "ai_image_generations"."image_url" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "ai_image_quotas" (
  "business_id" varchar(36) PRIMARY KEY NOT NULL,
  "monthly_limit_usd" double precision,
  "bonus_usd" double precision DEFAULT 0 NOT NULL,
  "bonus_period" varchar(7),
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "ai_image_quotas" ADD CONSTRAINT "ai_image_quotas_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Deny-by-default for the assistant's read-only role, like every other table
-- (0062 §2). No policy and no grant: Pimpo's spend is not the shop's data.
ALTER TABLE "ai_image_generations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_image_quotas" ENABLE ROW LEVEL SECURITY;
