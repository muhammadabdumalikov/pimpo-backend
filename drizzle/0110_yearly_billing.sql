-- Yearly billing (OBUNA-TOLOV.md §9): a 12-month period paid upfront, 20 % off
-- twelve months.
--
-- Idempotent; additive only. Both columns default to 'month', which is what
-- every existing period and every shop already is — no backfill.
--
--   billing_profiles.billing_cycle        the cycle the owner wants from the
--                                         next renewal on ('month' | 'year')
--   business_subscriptions.billing_cycle  the cycle THIS period was paid for;
--                                         mid-period charges prorate over it

ALTER TABLE "billing_profiles"
  ADD COLUMN IF NOT EXISTS "billing_cycle" varchar(8) DEFAULT 'month' NOT NULL;
ALTER TABLE "business_subscriptions"
  ADD COLUMN IF NOT EXISTS "billing_cycle" varchar(8) DEFAULT 'month' NOT NULL;
