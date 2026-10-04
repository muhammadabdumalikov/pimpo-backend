-- Schema parity: src/database/schema.ts is the single source of truth for
-- the database. Until now some objects lived only in hand-written SQL, and
-- `drizzle-kit push` drops whatever schema.ts doesn't declare (on 2026-10-02,
-- after a push, prod was found missing 7 of them). schema.ts now declares every
-- index the migrations create; this file brings an existing database in line:
--
--   1. monthly_targets — created on prod by `db:push` only, no migration had
--      it, so a database built from the migrations lacked it (and 0062's
--      policy loop died on it).
--   2. Every index push may have dropped, re-created if missing; the price
--      history index rebuilt newest-first if push turned it ascending.
--   3. Foreign keys that hand migrations created inline (Postgres names them
--      "<table>_<col>_fkey") renamed to drizzle's "<table>_<col>_<ref>_<refcol>_fk",
--      so push stops dropping and re-adding (re-validating) them.
--
-- Idempotent; safe to re-run. Apply with psql -f — NOT drizzle-kit migrate
-- (its journal stops at 0052) and NOT db:push. Some statements use
-- CONCURRENTLY, so do not wrap the file in BEGIN/COMMIT.
--
-- If a UNIQUE index fails, the data already breaks it (rows written while the
-- index was gone). Find them, fix them, re-run:
--   products PLU:  SELECT business_id, plu, count(*) FROM products WHERE plu IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
--   payroll:       SELECT staff_id, period_month, count(*) FROM payroll_entries WHERE type = 'accrual' GROUP BY 1,2 HAVING count(*) > 1;
--   label default: SELECT business_id, count(*) FROM label_templates WHERE is_default GROUP BY 1 HAVING count(*) > 1;
--   label names:   SELECT business_id, lower(name), count(*) FROM label_templates GROUP BY 1,2 HAVING count(*) > 1;
--   external acct: SELECT business_id, count(*) FROM accounts WHERE type = 'external' GROUP BY 1 HAVING count(*) > 1;
-- A failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS then
-- skips: the check at the end lists those — DROP it and re-run.

-- ── 1. monthly_targets ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "monthly_targets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"month" varchar(7) NOT NULL,
	"revenue_target" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "monthly_targets" ADD CONSTRAINT "monthly_targets_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_targets_business_month_uq" ON "monthly_targets" USING btree ("business_id","month");
-- The same RLS + AI read-only tenant policy 0062 gives every tenant table.
ALTER TABLE "monthly_targets" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pimpo_ai_ro') THEN
    DROP POLICY IF EXISTS ai_ro_tenant ON public.monthly_targets;
    CREATE POLICY ai_ro_tenant ON public.monthly_targets FOR SELECT TO pimpo_ai_ro
      USING (business_id = (SELECT nullif(current_setting('app.business_id', true), '')));
    GRANT SELECT ON public.monthly_targets TO pimpo_ai_ro;
  END IF;
END $$;

-- ── 2. Indexes ──────────────────────────────────────────────────────────────
-- Big, write-hot tables build CONCURRENTLY so the till keeps selling.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "mxik_classifier_name_trgm_idx" ON "mxik_classifier" USING gin ("name" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_business_branch_idx" ON "orders" ("business_id","branch_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_business_branch_idx" ON "products" ("business_id","branch_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_business_created_idx" ON "products" ("business_id", "created_at" DESC, "id" DESC) WHERE "is_active";
CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_business_bonus_idx" ON "users" ("business_id", "bonus_balance" DESC, "created_at" DESC, "id" DESC) WHERE "is_active";
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "products_business_plu_uniq" ON "products" ("business_id", "plu") WHERE "plu" IS NOT NULL;
-- Small tables: a plain build is instant and fails atomically.
CREATE INDEX IF NOT EXISTS "subscription_discounts_business_idx" ON "subscription_discounts" ("business_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_entries_accrual_period_uq" ON "payroll_entries" ("staff_id","period_month") WHERE "type" = 'accrual';
CREATE UNIQUE INDEX IF NOT EXISTS "label_templates_one_default_idx" ON "label_templates" ("business_id") WHERE "is_default";
CREATE UNIQUE INDEX IF NOT EXISTS "label_templates_business_name_idx" ON "label_templates" ("business_id", lower("name"));
CREATE INDEX IF NOT EXISTS "financial_transactions_pair_idx" ON "financial_transactions" ("pair_id") WHERE "pair_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_business_external_uq" ON "accounts" ("business_id") WHERE "type" = 'external';
-- schema.ts used to declare this one ascending, and push compares column
-- order: rebuild it newest-first wherever it ended up ascending.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'product_price_history_product_idx'
      AND indexdef NOT LIKE '%created_at DESC%'
  ) THEN
    DROP INDEX public.product_price_history_product_idx;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "product_price_history_product_idx" ON "product_price_history" ("business_id", "product_id", "created_at" DESC);

-- ── 3. Foreign key names ────────────────────────────────────────────────────
-- A rename is catalogue-only: no re-validation, no table scan.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('announcement_reads', 'announcement_reads_announcement_id_fkey', 'announcement_reads_announcement_id_announcements_id_fk'),
      ('announcement_reads', 'announcement_reads_business_id_fkey', 'announcement_reads_business_id_businesses_id_fk'),
      ('announcement_targets', 'announcement_targets_announcement_id_fkey', 'announcement_targets_announcement_id_announcements_id_fk'),
      ('announcement_targets', 'announcement_targets_business_id_fkey', 'announcement_targets_business_id_businesses_id_fk'),
      ('business_feature_flags', 'business_feature_flags_business_id_fkey', 'business_feature_flags_business_id_businesses_id_fk'),
      ('defective_lots', 'defective_lots_business_id_fkey', 'defective_lots_business_id_businesses_id_fk'),
      ('defective_lots', 'defective_lots_product_id_fkey', 'defective_lots_product_id_products_id_fk'),
      ('defective_movement_items', 'defective_movement_items_business_id_fkey', 'defective_movement_items_business_id_businesses_id_fk'),
      ('defective_movement_items', 'defective_movement_items_movement_id_fkey', 'defective_movement_items_movement_id_defective_movements_id_fk'),
      ('defective_movements', 'defective_movements_business_id_fkey', 'defective_movements_business_id_businesses_id_fk'),
      ('devices', 'devices_branch_id_fkey', 'devices_branch_id_branches_id_fk'),
      ('devices', 'devices_business_id_fkey', 'devices_business_id_businesses_id_fk'),
      ('devices', 'devices_register_id_fkey', 'devices_register_id_cash_registers_id_fk'),
      ('invoice_scans', 'invoice_scans_business_id_fkey', 'invoice_scans_business_id_businesses_id_fk'),
      ('label_settings', 'label_settings_business_id_fkey', 'label_settings_business_id_businesses_id_fk'),
      ('label_templates', 'label_templates_business_id_fkey', 'label_templates_business_id_businesses_id_fk'),
      ('product_price_history', 'product_price_history_business_id_fkey', 'product_price_history_business_id_businesses_id_fk'),
      ('product_price_history', 'product_price_history_product_id_fkey', 'product_price_history_product_id_products_id_fk'),
      ('receipt_sequences', 'receipt_sequences_business_id_fkey', 'receipt_sequences_business_id_businesses_id_fk'),
      ('sale_return_items', 'sale_return_items_business_id_fkey', 'sale_return_items_business_id_businesses_id_fk'),
      ('sale_return_items', 'sale_return_items_return_id_fkey', 'sale_return_items_return_id_sale_returns_id_fk'),
      ('sale_returns', 'sale_returns_branch_id_fkey', 'sale_returns_branch_id_branches_id_fk'),
      ('sale_returns', 'sale_returns_business_id_fkey', 'sale_returns_business_id_businesses_id_fk'),
      ('sale_returns', 'sale_returns_order_id_fkey', 'sale_returns_order_id_orders_id_fk'),
      ('sale_returns', 'sale_returns_user_id_fkey', 'sale_returns_user_id_users_id_fk'),
      ('supplier_credits', 'supplier_credits_business_id_fkey', 'supplier_credits_business_id_businesses_id_fk')
    ) v(tbl, old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid = to_regclass(format('public.%I', r.tbl)) AND conname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid = to_regclass(format('public.%I', r.tbl)) AND conname = r.new_name)
    THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- ── 4. Check: must return no rows ───────────────────────────────────────────
SELECT indexrelid::regclass AS invalid_index FROM pg_index WHERE NOT indisvalid;
