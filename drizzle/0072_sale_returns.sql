-- Customer returns ("qaytarish") + human receipt numbers ("chek raqami").
--
-- A cashier finds the sale by the number printed on the receipt, picks the
-- lines coming back, and the refund is written as its own document. The
-- original order is never rewritten: reports net the return on the day it
-- happens, and the return rows are the history.
--
-- Idempotent throughout; safe to re-run. Run BEFORE deploying the backend
-- that reads these columns.

-- ── 1. Receipt numbers ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "receipt_sequences" (
  "business_id" varchar(36) PRIMARY KEY NOT NULL
    REFERENCES "businesses"("id") ON DELETE CASCADE,
  "last_no" integer DEFAULT 0 NOT NULL
);

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "receipt_no" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "returned_amount" numeric(12, 2) DEFAULT '0' NOT NULL;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "returned_quantity" double precision DEFAULT 0 NOT NULL;

-- Number every existing non-draft order per business, oldest first, continuing
-- after any number already issued (so a re-run after the new backend started
-- numbering never collides). Held drafts stay NULL.
WITH base AS (
  SELECT business_id, COALESCE(MAX(receipt_no), 0) AS m
  FROM "orders"
  GROUP BY business_id
),
numbered AS (
  SELECT o.id,
         b.m + ROW_NUMBER() OVER (PARTITION BY o.business_id ORDER BY o.created_at, o.id) AS n
  FROM "orders" o
  JOIN base b ON b.business_id = o.business_id
  WHERE o.status <> 'Held' AND o.receipt_no IS NULL
)
UPDATE "orders" o SET receipt_no = numbered.n
FROM numbered
WHERE o.id = numbered.id;

INSERT INTO "receipt_sequences" (business_id, last_no)
SELECT business_id, MAX(receipt_no)
FROM "orders"
WHERE receipt_no IS NOT NULL
GROUP BY business_id
ON CONFLICT (business_id)
DO UPDATE SET last_no = GREATEST("receipt_sequences".last_no, EXCLUDED.last_no);

CREATE UNIQUE INDEX IF NOT EXISTS "orders_business_receipt_no_uq"
  ON "orders" ("business_id", "receipt_no");

-- ── 2. Return documents ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sale_returns" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "order_id" varchar(36) NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "order_receipt_no" integer,
  "branch_id" varchar(36) REFERENCES "branches"("id") ON DELETE SET NULL,
  "shift_id" varchar(36),
  "cashier_id" varchar(36),
  "cashier_name" varchar(255),
  "credited_staff_id" varchar(36),
  "credited_staff_name" varchar(255),
  "user_id" varchar(36) REFERENCES "users"("id") ON DELETE SET NULL,
  "customer_name" varchar(255),
  "reason" varchar(500),
  "item_count" integer DEFAULT 0 NOT NULL,
  "gross_amount" numeric(12, 2) NOT NULL,
  "discount_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
  "total_amount" numeric(12, 2) NOT NULL,
  "debt_reduced" numeric(12, 2) DEFAULT '0' NOT NULL,
  "points_restored" numeric(12, 2) DEFAULT '0' NOT NULL,
  "points_reversed" numeric(12, 2) DEFAULT '0' NOT NULL,
  "refund_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
  "refunds" jsonb,
  "cost_total" numeric(12, 2) DEFAULT '0' NOT NULL,
  "restocked_cost" numeric(12, 2) DEFAULT '0' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "sale_returns_business_created_idx" ON "sale_returns" ("business_id", "created_at");
CREATE INDEX IF NOT EXISTS "sale_returns_order_idx" ON "sale_returns" ("order_id");
CREATE INDEX IF NOT EXISTS "sale_returns_shift_idx" ON "sale_returns" ("shift_id");

CREATE TABLE IF NOT EXISTS "sale_return_items" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "return_id" varchar(36) NOT NULL REFERENCES "sale_returns"("id") ON DELETE CASCADE,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "order_item_id" varchar(36) NOT NULL,
  "product_id" varchar(36),
  "product_name" varchar(255) NOT NULL,
  "quantity" double precision NOT NULL,
  "price_out" numeric(10, 2) NOT NULL,
  "line_total" numeric(12, 2) NOT NULL,
  "net_amount" numeric(12, 2) NOT NULL,
  "cost_in" numeric(10, 2) DEFAULT '0' NOT NULL,
  "cost_total" numeric(12, 2) DEFAULT '0' NOT NULL,
  "restock" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "sale_return_items_return_idx" ON "sale_return_items" ("return_id");
CREATE INDEX IF NOT EXISTS "sale_return_items_product_idx" ON "sale_return_items" ("business_id", "product_id");

-- ── 3. AI read-only role: same tenant policy as every other business table ──
-- (see 0062). Skipped when the role doesn't exist in this database.
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pimpo_ai_ro') THEN
    FOREACH t IN ARRAY ARRAY['sale_returns', 'sale_return_items'] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS ai_ro_tenant ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY ai_ro_tenant ON public.%I FOR SELECT TO pimpo_ai_ro '
        'USING (business_id = (SELECT nullif(current_setting(''app.business_id'', true), '''')))',
        t);
      EXECUTE format('GRANT SELECT ON public.%I TO pimpo_ai_ro', t);
    END LOOP;
  END IF;
END $$;
