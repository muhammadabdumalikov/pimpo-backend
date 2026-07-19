ALTER TABLE "orders" ADD COLUMN "branch_id" varchar(36);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill: attribute existing orders to their business's default branch so the
-- per-store report filter works on historical sales. Businesses without a
-- default branch keep NULL (treated as "all stores") until one is created.
UPDATE "orders" o
SET "branch_id" = b."id"
FROM "branches" b
WHERE b."business_id" = o."business_id"
  AND b."is_default" = true
  AND o."branch_id" IS NULL;
--> statement-breakpoint
-- Speed up per-branch report aggregations.
CREATE INDEX IF NOT EXISTS "orders_business_branch_idx" ON "orders" ("business_id","branch_id");
