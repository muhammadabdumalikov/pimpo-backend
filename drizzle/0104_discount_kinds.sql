-- Subscription discounts beyond "a percent off the plan": a fixed sum off the
-- month, a special price for the plan or for each extra branch, a percent on
-- the branches, and a discount tied to one plan tier.
--
-- Idempotent; additive only — defaulted/nullable columns the running code
-- never reads. The defaults describe every existing row (a percent off the
-- plan, on whatever plan the shop is on).

ALTER TABLE "subscription_discounts" ADD COLUMN IF NOT EXISTS "kind" varchar(16) DEFAULT 'percent' NOT NULL;
ALTER TABLE "subscription_discounts" ADD COLUMN IF NOT EXISTS "scope" varchar(16) DEFAULT 'plan' NOT NULL;
ALTER TABLE "subscription_discounts" ADD COLUMN IF NOT EXISTS "amount" integer;
ALTER TABLE "subscription_discounts" ADD COLUMN IF NOT EXISTS "plan_tier" varchar(20);
