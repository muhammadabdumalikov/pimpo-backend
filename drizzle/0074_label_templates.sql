-- Named label layouts ("Etiketka shablonlari"), many per business.
--
-- A shop does not print one kind of label. The 58x40 roll carries shelf tags,
-- small goods get 30x20 stickers, the scale wants its own — and until now the
-- only way to switch was to go back into Sozlamalar and retype the layout.
-- Each of those is a row here, and printing asks which one to use.
--
-- This supersedes `label_settings`, which held a single layout per business:
-- every existing row is copied below as "Standart" and marked default, and the
-- old `/settings/label` endpoints keep working by reading and writing whichever
-- template carries `is_default`. `label_settings` is left in place (unread) so
-- a rollback to the previous backend still finds its data.
--
-- A business with no `label_settings` row gets its "Standart" seeded by the
-- service on the first read, from the same defaults — nothing to backfill here.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend that reads it.

CREATE TABLE IF NOT EXISTS "label_templates" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL
    REFERENCES "businesses"("id") ON DELETE CASCADE,
  "name" varchar(60) NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "width_mm" integer DEFAULT 58 NOT NULL,
  "height_mm" integer DEFAULT 40 NOT NULL,
  "padding_mm" integer DEFAULT 2 NOT NULL,
  "show_store_name" boolean DEFAULT false NOT NULL,
  "show_name" boolean DEFAULT true NOT NULL,
  "name_lines" integer DEFAULT 2 NOT NULL,
  "show_price" boolean DEFAULT true NOT NULL,
  "show_code" boolean DEFAULT false NOT NULL,
  "show_barcode" boolean DEFAULT true NOT NULL,
  "show_barcode_text" boolean DEFAULT true NOT NULL,
  "show_plu" boolean DEFAULT false NOT NULL,
  "barcode_height_mm" integer DEFAULT 8 NOT NULL,
  "font_scale" integer DEFAULT 100 NOT NULL,
  "copies" integer DEFAULT 1 NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- `show_plu` arrived after the first draft of this file; an environment that
-- already ran that draft gets the column here instead of a migration of its
-- own, since 0074 had not shipped anywhere yet.
ALTER TABLE "label_templates"
  ADD COLUMN IF NOT EXISTS "show_plu" boolean DEFAULT false NOT NULL;

CREATE INDEX IF NOT EXISTS "label_templates_business_idx"
  ON "label_templates" ("business_id");

-- At most one default per business, enforced by the database rather than by
-- the order of two UPDATEs: "which label do I print?" must never have two
-- answers. The service still clears the old default before setting a new one;
-- this is what makes a concurrent second request fail instead of tie.
CREATE UNIQUE INDEX IF NOT EXISTS "label_templates_one_default_idx"
  ON "label_templates" ("business_id")
  WHERE "is_default";

-- Two shops may both call a template "Kichik"; one shop may not.
CREATE UNIQUE INDEX IF NOT EXISTS "label_templates_business_name_idx"
  ON "label_templates" ("business_id", lower("name"));

-- Carry each business's existing single layout across, under a name it will
-- recognise. Skipped for any business that already has a template, so a re-run
-- (or a business created after this migration) changes nothing.
INSERT INTO "label_templates" (
  "id", "business_id", "name", "is_default",
  "width_mm", "height_mm", "padding_mm",
  "show_store_name", "show_name", "name_lines",
  "show_price", "show_code", "show_barcode", "show_barcode_text",
  "barcode_height_mm", "font_scale", "copies", "sort_order",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text, ls."business_id", 'Standart', true,
  ls."width_mm", ls."height_mm", ls."padding_mm",
  ls."show_store_name", ls."show_name", ls."name_lines",
  ls."show_price", ls."show_code", ls."show_barcode", ls."show_barcode_text",
  ls."barcode_height_mm", ls."font_scale", ls."copies", 0,
  ls."updated_at", ls."updated_at"
FROM "label_settings" ls
WHERE NOT EXISTS (
  SELECT 1 FROM "label_templates" lt WHERE lt."business_id" = ls."business_id"
);
