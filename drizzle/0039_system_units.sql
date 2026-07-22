-- System units shared by every business: business_id NULL marks a global,
-- immutable row. Dona and Kilogramm always exist out of the box.
ALTER TABLE "units" ALTER COLUMN "business_id" DROP NOT NULL;--> statement-breakpoint
INSERT INTO "units" ("id", "business_id", "name", "short_name", "precision")
VALUES
	('unit-system-dona', NULL, 'Dona', 'dona', 0),
	('unit-system-kg', NULL, 'Kilogramm', 'kg', 3)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Per-business copies seeded before this migration duplicate the new global
-- rows — drop them (nothing references units yet, so this is safe).
DELETE FROM "units" WHERE "business_id" IS NOT NULL AND "name" IN ('Dona', 'Kilogramm');
