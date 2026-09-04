-- Fiscalization groundwork (FISCALIZATION.md): every fiscal receipt line must
-- carry the product's 17-digit national classifier code (MXIK/IKPU) and its
-- packaging code, so the product itself has to remember which classifier row it
-- maps to. Both nullable — a product without them simply can't be fiscalized
-- yet, which is exactly the state every existing row starts in.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "mxik_code" varchar(17);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "package_code" varchar(20);
--> statement-breakpoint
-- The product form searches the ~383k-row classifier by free text ("non",
-- "pepsi"). That is an unanchored ILIKE, which no btree index can serve, so
-- give it a trigram GIN index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- CONCURRENTLY because this file is applied by hand with psql against the live
-- database (the drizzle journal has been frozen since 0052). It cannot run
-- inside a transaction block — do NOT wrap this file in BEGIN/COMMIT, and do
-- not feed it to `drizzle-kit migrate`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "mxik_classifier_name_trgm_idx"
  ON "mxik_classifier" USING gin ("name" gin_trgm_ops);
