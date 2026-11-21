-- The customer AI bot goes pay-as-you-go (ONLAYN-SOTUVCHI.md §10, 2026-11-21).
--
-- The 149 000 add-on is gone: the bot is part of the online seller plan and
-- of Business+, and every answer is billed at its token cost plus our margin
-- (billing/ai-usage.ts). Free answers (the online trial's 500, Business+'s
-- 2 000 a month) are counted from customer_chat_messages, so they need no
-- column of their own.
--
-- Idempotent; additive only. The two ai_addon columns (0109) stay — the code
-- stops reading them with this deploy and a later one drops them.
--
--   customer_chat_messages.cost_uzs       so'm this answer cost the shop
--                                         (0 = a free one); null on every row
--                                         that is not an AI answer
--   billing_profiles.ai_unbilled          so'm of answers not yet taken from
--                                         the balance (settled once a day)
--   billing_profiles.ai_unbilled_answers  how many answers that sum is

ALTER TABLE "customer_chat_messages"
  ADD COLUMN IF NOT EXISTS "cost_uzs" numeric(12, 2);
ALTER TABLE "billing_profiles"
  ADD COLUMN IF NOT EXISTS "ai_unbilled" numeric(14, 2) DEFAULT '0' NOT NULL;
ALTER TABLE "billing_profiles"
  ADD COLUMN IF NOT EXISTS "ai_unbilled_answers" integer DEFAULT 0 NOT NULL;
