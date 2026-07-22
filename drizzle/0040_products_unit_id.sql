ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unit_id" varchar(36);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill from the legacy quantityType marker onto the global system units.
UPDATE "products" SET "unit_id" = 'unit-system-kg' WHERE "quantity_type" = 'kg' AND "unit_id" IS NULL;--> statement-breakpoint
UPDATE "products" SET "unit_id" = 'unit-system-dona' WHERE "quantity_type" = 'piece' AND "unit_id" IS NULL;
