-- Storefront banners: the pictures (with optional text laid over them) at the
-- top of a shop's online store, managed under Settings → Online store.
--
-- Idempotent; safe to re-run. Additive only — one new table nothing running
-- today reads.
--
--   store_banners   one row per banner: picture, optional title / subtitle /
--                   button label drawn over it, where a tap leads (a product,
--                   a category, an outside link, or nowhere), its place in the
--                   carousel, an on/off switch and an optional date window
--                   (business-zone days, both inclusive)

CREATE TABLE IF NOT EXISTS "store_banners" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "image" varchar(500) NOT NULL,
  "title" varchar(80),
  "subtitle" varchar(140),
  "button_label" varchar(30),
  "link_type" varchar(12) DEFAULT 'none' NOT NULL,
  "link_value" varchar(500),
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "starts_on" date,
  "ends_on" date,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "store_banners" ADD CONSTRAINT "store_banners_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "store_banners_business_order_idx" ON "store_banners" USING btree ("business_id","sort_order");

-- Deny-by-default for the assistant's read-only role, like every other table
-- (0062 §2).
ALTER TABLE "store_banners" ENABLE ROW LEVEL SECURITY;
