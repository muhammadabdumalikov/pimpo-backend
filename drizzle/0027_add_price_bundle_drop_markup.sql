ALTER TABLE "products" ADD COLUMN "price_bundle" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "markup_percent";