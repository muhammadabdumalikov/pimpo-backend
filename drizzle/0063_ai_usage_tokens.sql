-- Token + spend counters for the AI assistant's settings page.
--
-- Applied by hand like 0061/0062: the drizzle journal is frozen at idx 52, so
-- `db:migrate` will not pick this file up and `drizzle-kit generate` must not
-- be run against it.
--
-- Existing rows get 0 and start accumulating from the next question. The three
-- columns reset together with `monthly_count` when `monthly_period` rolls over
-- (see AiSettingsService.recordUsage) — no separate cleanup job.

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS monthly_input_tokens integer NOT NULL DEFAULT 0;

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS monthly_output_tokens integer NOT NULL DEFAULT 0;

-- Double precision, not numeric: this is an ESTIMATE shown to the shop owner
-- from our own price table, never an invoice. The provider's bill is the
-- authority, and a model we have no published price for contributes 0.
ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS monthly_cost_usd double precision NOT NULL DEFAULT 0;
