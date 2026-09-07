-- Label-printing scales (Rongta RLS and friends). Two things are needed before
-- the till can accept a scale's own label:
--
--   1. a short numeric PLU on the product, because `code` is free text and is
--      generated as "PRD-0001" — nothing a scale can hold;
--   2. somewhere to record what the shop's scales actually print, since the
--      barcode layout is redrawn in each scale's own menu.
--
-- Applied by hand with psql against the live database (the drizzle journal has
-- been frozen since 0052). Contains a CONCURRENTLY index, so it cannot run
-- inside a transaction block — do NOT wrap this file in BEGIN/COMMIT, and do
-- not feed it to `drizzle-kit migrate`.

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "plu" integer;
--> statement-breakpoint

-- A duplicated PLU is silent corruption, not a visible error: the label scans,
-- the wrong product goes on the receipt, the receipt looks fine, and only the
-- stock drifts. Application-level checks are not enough for that — `products`
-- carries no unique constraints today and the existing code/barcode checks
-- disagree with each other about whether inactive rows count — so this one is
-- enforced by the database.
--
-- CONCURRENTLY keeps the till writable while it builds. If it fails it leaves
-- an INVALID index behind: DROP INDEX "products_business_plu_uniq" and re-run
-- (a failure here almost always means real duplicate PLUs to reconcile first).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "products_business_plu_uniq"
  ON "products" ("business_id", "plu") WHERE "plu" IS NOT NULL;
--> statement-breakpoint

-- Off by default with no formats: a shop that owns no scale keeps the till's
-- old scan behaviour exactly, and cannot be surprised by a manufacturer
-- barcode that happens to fit a scale layout. The service falls back to the
-- regional default layout (EAN-13, "22" prefix, 5-digit PLU, grams) when the
-- list is empty, so turning the feature on is a one-click affair.
CREATE TABLE IF NOT EXISTS "scale_settings" (
	"business_id" varchar(36) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scale_settings" ADD CONSTRAINT "scale_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
