-- Delivery-note scans still under review ("tugallanmagan skaner").
--
-- Reading a note with AI and then checking every row by hand is long work that
-- used to live only in the browser tab: a closed drawer, a reload or a crash
-- threw it away — and left behind any products already made for its rows. The
-- review is now saved as it goes and resumed later, on any device. Only the
-- read and the corrections are kept, never the photos.
--
-- A shop keeps a list of them (several suppliers deliver on one day) and they
-- belong to the shop: anyone who may write a receipt sees and can finish them.
-- `account_id` is who started one; `updated_by_id` who saved it last. `state`
-- is the drawer's review, opaque to the server; `created_product_ids` lets a
-- discard offer to remove the products it made.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend that reads it.

CREATE TABLE IF NOT EXISTS "invoice_scans" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL
    REFERENCES "businesses"("id") ON DELETE CASCADE,
  "account_id" varchar(36) NOT NULL,
  "updated_by_id" varchar(36),
  "supplier_name" varchar(255),
  "document_number" varchar(100),
  "document_date" varchar(10),
  "state" jsonb,
  "row_count" integer DEFAULT 0 NOT NULL,
  "page_count" integer DEFAULT 0 NOT NULL,
  "created_product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Earlier drafts of this file (never deployed) kept one scan per account and
-- stored the photos. Where one of them already ran, bring the table to the
-- shape above.
DROP INDEX IF EXISTS "invoice_scans_business_account_uq";
ALTER TABLE "invoice_scans" ADD COLUMN IF NOT EXISTS "updated_by_id" varchar(36);
ALTER TABLE "invoice_scans" ADD COLUMN IF NOT EXISTS "supplier_name" varchar(255);
ALTER TABLE "invoice_scans" ADD COLUMN IF NOT EXISTS "document_number" varchar(100);
ALTER TABLE "invoice_scans" ADD COLUMN IF NOT EXISTS "document_date" varchar(10);
ALTER TABLE "invoice_scans" ADD COLUMN IF NOT EXISTS "page_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "invoice_scans" DROP COLUMN IF EXISTS "pages";

CREATE INDEX IF NOT EXISTS "invoice_scans_business_updated_idx"
  ON "invoice_scans" ("business_id", "updated_at");

CREATE INDEX IF NOT EXISTS "invoice_scans_business_account_idx"
  ON "invoice_scans" ("business_id", "account_id");

CREATE INDEX IF NOT EXISTS "invoice_scans_updated_idx"
  ON "invoice_scans" ("updated_at");
