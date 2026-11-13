-- Delivery-note scanner on Pimpo's own key: whose key paid for a read.
--
-- Idempotent; safe to re-run. Additive only — a new column whose default keeps
-- every existing row (and every row the old code still writes during the
-- rollout) a read on the shop's own key.
--
--   ai_invoice_reads.key_source   'shop' | 'platform'. A shop with its own AI
--                                 key reads without a cap; one without it reads
--                                 on Pimpo's key, and the pages of those
--                                 'platform' rows are what its monthly plan
--                                 allowance (Business 100, Business+ 500) and
--                                 the platform's scanner budget sum over.

ALTER TABLE "ai_invoice_reads"
  ADD COLUMN IF NOT EXISTS "key_source" varchar(10) DEFAULT 'shop' NOT NULL;
