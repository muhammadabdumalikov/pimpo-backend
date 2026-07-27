-- Staff become employee records (account optional) + payroll ledger.
--
-- Every pre-existing staff row WAS an account holder, so has_account is
-- backfilled to true before the NOT NULL default takes effect for new rows.
-- Dropping NOT NULL on login/password/role_id is what allows an accountless
-- employee (cleaner, warehouse hand) to exist purely as a payroll record.

ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "has_account" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "position" varchar(100);
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "phone" varchar(32);
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "branch_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "hired_at" timestamp;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "salary_type" varchar(10) DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "base_salary" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "sales_percent" numeric(6, 3) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "percent_base" varchar(10) DEFAULT 'revenue' NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "salary_balance" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint

-- Existing rows all had credentials: mark them as account holders so seat
-- counting and login keep working exactly as before this migration.
UPDATE "staff" SET "has_account" = true WHERE "login" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "staff" ALTER COLUMN "login" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ALTER COLUMN "password" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ALTER COLUMN "role_id" DROP NOT NULL;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "staff" ADD CONSTRAINT "staff_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payroll_entries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"staff_id" varchar(36) NOT NULL,
	"staff_name" varchar(255) NOT NULL,
	"type" varchar(12) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"balance_after" numeric(14, 2) NOT NULL,
	"period_month" varchar(7),
	"base_amount" numeric(14, 2),
	"sales_amount" numeric(14, 2),
	"sales_base" numeric(14, 2),
	"percent_applied" numeric(6, 3),
	"account_id" varchar(36),
	"financial_transaction_id" varchar(36),
	"note" varchar(500),
	"created_by_id" varchar(36),
	"created_by_name" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_entries_staff_created_idx" ON "payroll_entries" ("staff_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_entries_business_created_idx" ON "payroll_entries" ("business_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_entries_business_period_idx" ON "payroll_entries" ("business_id","period_month");
--> statement-breakpoint
-- Re-running a month's accrual must never double-pay: one accrual row per
-- (staff, month). Partial so payments/advances stay unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_entries_accrual_period_uq" ON "payroll_entries" ("staff_id","period_month") WHERE "type" = 'accrual';
