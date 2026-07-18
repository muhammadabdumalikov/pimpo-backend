CREATE TABLE IF NOT EXISTS "branches" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"address" varchar(500),
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "branch_id" varchar(36);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branches" ADD CONSTRAINT "branches_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill: give every existing business a default branch ("Asosiy do'kon")...
INSERT INTO "branches" ("id", "business_id", "name", "is_default", "is_active")
SELECT gen_random_uuid()::text, "id", 'Asosiy do''kon', true, true
FROM "businesses";
--> statement-breakpoint
-- ...then attach all existing receipts to their business default branch.
UPDATE "goods_receipts" gr
SET "branch_id" = (
	SELECT b."id" FROM "branches" b
	WHERE b."business_id" = gr."business_id" AND b."is_default" = true
	LIMIT 1
)
WHERE gr."branch_id" IS NULL;
