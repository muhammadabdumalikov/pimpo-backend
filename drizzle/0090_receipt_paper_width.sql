-- Receipt templates remember the thermal roll width (58 | 80 mm), so the
-- editor preview and the printed receipt use the same layout. Until now the
-- editor's 58/80 switch was preview-only and every till printed at 80 mm.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
ALTER TABLE "receipt_templates" ADD COLUMN IF NOT EXISTS "paper_width_mm" integer DEFAULT 80 NOT NULL;
