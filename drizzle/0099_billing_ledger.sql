-- Subscription billing (OBUNA-TOLOV.md §3): the balance pays for the plan.
-- A balance ledger, payment requests ("To'lov qildim"), platform settings (the
-- payment requisites), a per-period notice log, and three columns on
-- business_subscriptions (trial flag, scheduled downgrade, paid branch seats).
--
-- Idempotent; safe to re-run. Additive only: new defaulted/nullable columns and
-- new tables. The old code never reads them, so it keeps serving through the
-- rollout. Two data steps fill the new columns for existing rows.

-- 1. business_subscriptions
ALTER TABLE "business_subscriptions" ADD COLUMN IF NOT EXISTS "is_trial" boolean DEFAULT false NOT NULL;
ALTER TABLE "business_subscriptions" ADD COLUMN IF NOT EXISTS "pending_plan_id" varchar(36);
ALTER TABLE "business_subscriptions" ADD COLUMN IF NOT EXISTS "paid_extra_branches" integer DEFAULT 0 NOT NULL;
DO $$ BEGIN
 ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_pending_plan_id_subscription_plans_id_fk" FOREIGN KEY ("pending_plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- The signup trial: the shop's only subscription row, active and dated, on the
-- trial plan (basic, or food for a kitchen), spanning at most a month.
UPDATE "business_subscriptions" bs
   SET "is_trial" = true
  FROM "subscription_plans" p
 WHERE p."id" = bs."plan_id"
   AND p."tier" IN ('basic', 'food')
   AND bs."is_active"
   AND NOT bs."is_trial"
   AND bs."end_date" IS NOT NULL
   AND bs."end_date" - bs."start_date" <= interval '31 days'
   AND (SELECT count(*) FROM "business_subscriptions" o
         WHERE o."business_id" = bs."business_id") = 1;

-- Branch seats already open count as paid for the current period, so the next
-- branch is the first one charged.
UPDATE "business_subscriptions" bs
   SET "paid_extra_branches" = GREATEST(0, (
         SELECT count(*) FROM "branches" b
          WHERE b."business_id" = bs."business_id" AND b."is_active") - 1)
 WHERE bs."is_active"
   AND bs."paid_extra_branches" = 0;

-- 2. Balance ledger: every balance change, append-only. `amount` is signed.
CREATE TABLE IF NOT EXISTS "billing_transactions" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "type" varchar(20) NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "balance_after" numeric(14, 2) NOT NULL,
  "meta" jsonb,
  "internal_note" text,
  "created_by" varchar(64),
  "payment_request_id" varchar(36),
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "billing_transactions_business_created_idx" ON "billing_transactions" USING btree ("business_id","created_at");

-- 3. "To'lov qildim" requests, reviewed in the platform console. At most one
--    pending per shop, held by the partial unique index.
CREATE TABLE IF NOT EXISTS "payment_requests" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "comment" varchar(200),
  "status" varchar(10) DEFAULT 'pending' NOT NULL,
  "reject_reason" varchar(500),
  "requested_by_name" varchar(255),
  "transaction_id" varchar(36),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "resolved_at" timestamp
);
DO $$ BEGIN
 ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "payment_requests_one_pending_idx" ON "payment_requests" USING btree ("business_id") WHERE "payment_requests"."status" = 'pending';
CREATE INDEX IF NOT EXISTS "payment_requests_business_created_idx" ON "payment_requests" USING btree ("business_id","created_at");
CREATE INDEX IF NOT EXISTS "payment_requests_status_created_idx" ON "payment_requests" USING btree ("status","created_at");

-- 4. Platform-wide settings (key → JSON), e.g. `payment_requisites`.
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- 5. Billing reminders already sent: each kind once per period.
CREATE TABLE IF NOT EXISTS "billing_notices" (
  "business_id" varchar(36) NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "kind" varchar(16) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "billing_notices_business_id_period_end_kind_pk" PRIMARY KEY ("business_id","period_end","kind")
);
DO $$ BEGIN
 ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- 6. Deny-by-default for the assistant's read-only role, like billing_profiles
--    and business_subscriptions (0062 §7): no policy, no grant. This is the
--    platform's accounting, not shop data the assistant should query.
ALTER TABLE "billing_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_notices" ENABLE ROW LEVEL SECURITY;
