ALTER TABLE "cash_registers" ADD COLUMN "branch_id" varchar(36);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill: existing registers sell from the business's default branch.
UPDATE "cash_registers" r
SET "branch_id" = b."id"
FROM "branches" b
WHERE b."business_id" = r."business_id"
  AND b."is_default" = true
  AND r."branch_id" IS NULL;
