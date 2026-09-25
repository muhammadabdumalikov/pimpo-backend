-- Yaroqsiz tovarlar ombori: defective goods kept apart from sellable stock.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why: a customer return marked "Yaroqsiz" left no trace in stock, so the shop
-- could not send it back to the supplier (a supplier return only draws the
-- receipt's own unsold lots) and its cost was booked as a loss the moment it
-- came back — even when the supplier later took it off the debt. Defective
-- goods now sit in their own per-branch lots until the shop decides: back to
-- the supplier, swapped for good units, written off (the loss is booked then),
-- or back on sale. See YOQOTISHLAR.md.
--
-- Deliberately separate from branch_stock / inventory_batches: every reader of
-- sellable stock (checkout, catalogue, storefront, stock-takes, valuation)
-- stays untouched and can't sell a defective unit by accident.
--
-- Starts empty: past defective returns are not backfilled (most of those goods
-- are long gone); an owner can enter what is still on hand as opening stock.

CREATE TABLE IF NOT EXISTS "defective_lots" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "product_id" varchar(36) NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "branch_id" varchar(36) NOT NULL,
  "unit_cost" numeric(12, 2) NOT NULL,
  "qty_in" double precision NOT NULL,
  "qty_remaining" double precision NOT NULL,
  -- 'customer_return' | 'shelf' | 'opening'
  "source" varchar(20) NOT NULL,
  "movement_id" varchar(36),
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "defective_lots_stock_idx"
  ON "defective_lots" ("business_id", "product_id", "branch_id");

CREATE TABLE IF NOT EXISTS "defective_movements" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "branch_id" varchar(36) NOT NULL,
  -- in_return | in_shelf | in_opening | out_supplier | out_exchange |
  -- out_writeoff | out_to_sale
  "type" varchar(20) NOT NULL,
  "reason_code" varchar(20),
  "note" varchar(500),
  "sale_return_id" varchar(36),
  "receipt_id" varchar(36),
  "supplier_return_id" varchar(36),
  "supplier_id" varchar(36),
  "supplier_name" varchar(255),
  "item_count" integer DEFAULT 0 NOT NULL,
  "total_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
  "loss_value" numeric(14, 2) DEFAULT '0' NOT NULL,
  "credit_value" numeric(14, 2),
  "currency" varchar(3),
  "cashier_id" varchar(36),
  "cashier_name" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "defective_movements_business_created_idx"
  ON "defective_movements" ("business_id", "created_at");

CREATE TABLE IF NOT EXISTS "defective_movement_items" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "movement_id" varchar(36) NOT NULL REFERENCES "defective_movements"("id") ON DELETE CASCADE,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "product_id" varchar(36),
  "product_name" varchar(255) NOT NULL,
  "quantity" double precision NOT NULL,
  "unit_cost" numeric(12, 2) NOT NULL,
  "cost_total" numeric(14, 2) NOT NULL,
  "loss_value" numeric(14, 2) DEFAULT '0' NOT NULL,
  "reason_code" varchar(20),
  "note" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "defective_movement_items_movement_idx"
  ON "defective_movement_items" ("movement_id");
CREATE INDEX IF NOT EXISTS "defective_movement_items_product_idx"
  ON "defective_movement_items" ("business_id", "product_id");

-- A supplier return from defective stock moves only defective lots; stock
-- reports must not treat it as sellable stock leaving.
ALTER TABLE "supplier_returns"
  ADD COLUMN IF NOT EXISTS "source" varchar(12) DEFAULT 'stock' NOT NULL;

-- Where a returned line went: 'shelf' | 'defective_stock'; null = before this.
ALTER TABLE "sale_return_items" ADD COLUMN IF NOT EXISTS "disposition" varchar(20);
-- Past lines: restocked ones went to the shelf; past defective ones stay null
-- (they were a loss when they came back, and stay one).
UPDATE "sale_return_items" SET "disposition" = 'shelf'
WHERE "disposition" IS NULL AND "restock" = true;

-- ── AI read-only role: same tenant policy as every other business table ──
-- (see 0062). Skipped when the role doesn't exist in this database.
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pimpo_ai_ro') THEN
    FOREACH t IN ARRAY ARRAY['defective_lots', 'defective_movements', 'defective_movement_items'] LOOP
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
