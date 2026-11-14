-- Online seller plan + the AI bot add-on (ONLAYN-SOTUVCHI.md §10, E1–E8).
--
-- Idempotent; additive only. Both columns default to false, so every existing
-- shop is "no add-on" and nothing needs a backfill. The 'online' plan row
-- itself is seeded at boot (seed-plans.ts), like every other plan, and
-- businesses.business_type is a free varchar(10) — 'online' needs no change.
--
--   billing_profiles.ai_addon        the owner wants the add-on next period
--                                    (renewals add 149 000 while it is on)
--   business_subscriptions.ai_addon  the add-on is part of THIS period (paid,
--                                    or given with the online trial); the bot
--                                    answers while it is true

ALTER TABLE "billing_profiles"
  ADD COLUMN IF NOT EXISTS "ai_addon" boolean DEFAULT false NOT NULL;
ALTER TABLE "business_subscriptions"
  ADD COLUMN IF NOT EXISTS "ai_addon" boolean DEFAULT false NOT NULL;
