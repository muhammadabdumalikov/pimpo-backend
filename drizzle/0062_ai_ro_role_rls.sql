-- 0062_ai_ro_role_rls.sql
--
-- Postgres-enforced tenant isolation for LLM-generated SQL.
--
-- Creates a login role `pimpo_ai_ro` that can only SELECT, only from an
-- allowlisted set of tables, and only rows whose business_id matches the
-- transaction-local GUC `app.business_id`. The application role is unaffected.
--
-- The security boundary for ad-hoc SQL is THIS FILE, not the JS validator.
-- The validator turns a bad query into a good error message; these grants and
-- policies are what make a bad query harmless.
--
-- IDEMPOTENT: safe to re-run.
-- NO PASSWORD HERE: set it out of band (see the ops note at the bottom).
-- RUN AS: the role that owns public.* (the bootstrap superuser today).
--
-- DELIBERATELY NOT using `FORCE ROW LEVEL SECURITY`: the application role owns
-- these tables and must keep unfiltered access. FORCE would apply the policies
-- to the owner too, so the day DATABASE_URL stops pointing at a superuser,
-- every report in the app would silently return zero rows with no error.

-- ── 1. Role ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pimpo_ai_ro') THEN
    CREATE ROLE pimpo_ai_ro
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      CONNECTION LIMIT 4;
  END IF;
END $$;
--> statement-breakpoint

-- Server-side defaults. These hold even if the Node client forgets a SET LOCAL,
-- so the guarantees do not depend on application code being correct.
ALTER ROLE pimpo_ai_ro SET statement_timeout                   = '5s';
--> statement-breakpoint
ALTER ROLE pimpo_ai_ro SET idle_in_transaction_session_timeout = '5s';
--> statement-breakpoint
ALTER ROLE pimpo_ai_ro SET lock_timeout                        = '1s';
--> statement-breakpoint
ALTER ROLE pimpo_ai_ro SET default_transaction_read_only       = 'on';
--> statement-breakpoint
ALTER ROLE pimpo_ai_ro SET work_mem                            = '16MB';
--> statement-breakpoint
ALTER ROLE pimpo_ai_ro SET search_path                         = 'public';
--> statement-breakpoint
-- JIT compilation on an ad-hoc analytical query routinely costs more than the
-- query itself on a 2 vCPU host.
ALTER ROLE pimpo_ai_ro SET jit                                 = 'off';
--> statement-breakpoint

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO pimpo_ai_ro', current_database());
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO pimpo_ai_ro;
--> statement-breakpoint

-- ── 2. RLS ON for every table (deny-by-default backstop) ────────────────────
-- A new role starts with no table privileges, so this is belt to the grants'
-- braces: even a future accidental `GRANT SELECT ON ALL TABLES` yields no rows
-- for a table that has no policy.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname NOT LIKE '\_\_drizzle%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── 3. Tenant policies + SELECT grants ──────────────────────────────────────
-- The scalar-subquery wrapper around current_setting() is deliberate: the
-- planner then evaluates the GUC once as an InitPlan constant instead of per
-- row, and the predicate stays usable as an index qual on business_id.
-- nullif(...,'') with missing_ok = true means an UNSET GUC yields NULL, which
-- matches nothing — so a forgotten set_config fails closed, not open.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'accounts','account_balances','branches','branch_stock','brands',
    'cash_movements','cash_operation_categories','cash_registers','cash_shifts',
    'categories','debt_payments','financial_categories','financial_transactions',
    'goods_receipts','goods_receipt_items','inventory_batches',
    'loyalty_transactions','monthly_targets','order_items','orders',
    'payment_methods','payroll_entries','products','stock_take_items',
    'stock_takes','stock_transfer_items','stock_transfers','supplier_payments',
    'supplier_return_items','supplier_returns','suppliers','user_debts'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS ai_ro_tenant ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY ai_ro_tenant ON public.%I FOR SELECT TO pimpo_ai_ro '
      'USING (business_id = (SELECT nullif(current_setting(''app.business_id'', true), '''')))',
      t);
    EXECUTE format('GRANT SELECT ON public.%I TO pimpo_ai_ro', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── 4. units: business_id is NULLABLE (NULL = shared system unit) ───────────
DROP POLICY IF EXISTS ai_ro_tenant ON public.units;
--> statement-breakpoint
CREATE POLICY ai_ro_tenant ON public.units
  FOR SELECT TO pimpo_ai_ro
  USING (
    business_id IS NULL
    OR business_id = (SELECT nullif(current_setting('app.business_id', true), ''))
  );
--> statement-breakpoint
GRANT SELECT ON public.units TO pimpo_ai_ro;
--> statement-breakpoint

-- ── 5. staff: policy + COLUMN-LEVEL grant (no password, no login) ───────────
DROP POLICY IF EXISTS ai_ro_tenant ON public.staff;
--> statement-breakpoint
CREATE POLICY ai_ro_tenant ON public.staff
  FOR SELECT TO pimpo_ai_ro
  USING (business_id = (SELECT nullif(current_setting('app.business_id', true), '')));
--> statement-breakpoint
REVOKE ALL ON public.staff FROM pimpo_ai_ro;
--> statement-breakpoint
GRANT SELECT (
  id, business_id, role_id, name, has_account, position, phone, branch_id,
  hired_at, salary_type, base_salary, sales_percent, percent_base,
  salary_balance, is_active, created_at, updated_at
) ON public.staff TO pimpo_ai_ro;
--> statement-breakpoint

-- ── 6. users: policy + COLUMN-LEVEL grant, PII withheld ─────────────────────
-- Row values reach a third-party LLM API, so customer phone / email / address
-- are not granted. "Top customers by spend" works fine without them; if you
-- later decide the tradeoff is acceptable, add the columns here and say so in
-- the privacy policy.
DROP POLICY IF EXISTS ai_ro_tenant ON public.users;
--> statement-breakpoint
CREATE POLICY ai_ro_tenant ON public.users
  FOR SELECT TO pimpo_ai_ro
  USING (business_id = (SELECT nullif(current_setting('app.business_id', true), '')));
--> statement-breakpoint
REVOKE ALL ON public.users FROM pimpo_ai_ro;
--> statement-breakpoint
GRANT SELECT (
  id, business_id, name, is_active, bonus_balance, total_spent,
  created_at, updated_at
) ON public.users TO pimpo_ai_ro;
--> statement-breakpoint

-- ── 7. Tables intentionally left with NO grant ──────────────────────────────
--   businesses                     password hash
--   store_bots                     Telegram bot token
--   billz_migration_state          BiLLZ OAuth / refresh tokens
--   roles, billing_profiles, business_subscriptions, subscription_plans,
--   subscription_discounts, receipt_settings, receipt_templates,
--   loyalty_settings, payroll_settings, telegram_links,
--   telegram_notification_settings, billz_import_items, billz_import_jobs,
--   billz_staging, global_barcodes, mxik_classifier
-- They have RLS enabled and zero policies, so pimpo_ai_ro cannot read them.
--
-- WHEN YOU ADD A NEW TABLE: it inherits neither RLS nor a grant here, which is
-- fail-closed and therefore correct — but the assistant will not see it either.
-- Add it to the array in step 3 (and to ALLOWED_TABLES in
-- src/ai-sql/sql-validator.ts) if the assistant should be able to query it.
--
-- OPS (run once, NOT committed):
--   ALTER ROLE pimpo_ai_ro WITH PASSWORD '<32+ random chars>';
-- then set AI_DATABASE_URL to that role's DSN.
--
-- BEFORE APPLYING, verify on the target server:
--   SELECT version();
--   SELECT tableowner FROM pg_tables WHERE schemaname = 'public' LIMIT 1;
--   \dx                        -- if dblink / postgres_fdw are installed,
--                              -- REVOKE EXECUTE on their functions FROM PUBLIC
