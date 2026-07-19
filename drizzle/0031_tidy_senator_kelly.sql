ALTER TABLE "products" ADD COLUMN "branch_id" varchar(36);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill: assign every existing product to its business's default branch so a
-- per-branch stock-take finds them. Businesses without a default branch keep
-- NULL (treated as "unassigned") until one is created.
UPDATE "products" p
SET "branch_id" = b."id"
FROM "branches" b
WHERE b."business_id" = p."business_id"
  AND b."is_default" = true
  AND p."branch_id" IS NULL;
--> statement-breakpoint
-- Speed up the per-branch catalogue snapshot a stock-take runs.
CREATE INDEX IF NOT EXISTS "products_business_branch_idx" ON "products" ("business_id","branch_id");
