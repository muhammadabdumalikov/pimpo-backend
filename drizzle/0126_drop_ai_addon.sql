-- Drop the AI bot add-on columns of 0109 (ONLAYN-SOTUVCHI.md §11).
--
-- Unused since 0125: the add-on is gone and the bot's answers are billed as
-- they are used. The previous deploy already removed both columns from
-- schema.ts and the code (drizzle/pending-drops.txt), so no running server
-- reads or writes them any more. Ship this only once that deploy is live
-- everywhere, and remove both lines from pending-drops.txt in the same
-- commit.
--
-- Idempotent.

ALTER TABLE "billing_profiles" DROP COLUMN IF EXISTS "ai_addon";
ALTER TABLE "business_subscriptions" DROP COLUMN IF EXISTS "ai_addon";
