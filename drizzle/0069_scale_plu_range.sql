-- PLU numbering window, configured in Sozlamalar → Etiketka.
--
-- Until now "Avtomatik" always walked the pool from 1 upward and the only cap
-- was the width of the narrowest scale barcode layout. A shop that keeps a
-- block of low numbers for its old scale list (or numbers departments in
-- blocks) needs to say where its own window starts and ends.
--
-- plu_start defaults to 1 and plu_end to NULL, so every existing business keeps
-- exactly the behaviour it has today — nothing to backfill.
ALTER TABLE "scale_settings"
  ADD COLUMN IF NOT EXISTS "plu_start" integer NOT NULL DEFAULT 1;

ALTER TABLE "scale_settings"
  ADD COLUMN IF NOT EXISTS "plu_end" integer;
