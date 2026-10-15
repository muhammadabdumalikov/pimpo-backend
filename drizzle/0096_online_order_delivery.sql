-- Online-order delivery (YETKAZISH.md): pickup vs delivery, the assembling /
-- delivering / ready-for-pickup statuses, a status history, store delivery
-- settings and the delivery fee on returns.
--
-- Idempotent; safe to re-run. Additive except one data step: storefront
-- orders still in 'Confirmed' move to 'Assembling' (Q2 — accepting an order
-- now starts assembling it). The old code shows an unknown status raw and
-- refuses no reads over it, so it keeps serving through the rollout.

-- 1. Orders: fulfilment, delivery fee (outside total_amount), courier, the
--    moment the customer placed the order, customer locale, cancel reason.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_type" varchar(10);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_address" varchar(500);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_lat" double precision;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_lng" double precision;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_fee" numeric(12, 2) DEFAULT '0' NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_id" varchar(36);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_name" varchar(255);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_phone" varchar(32);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "placed_at" timestamp;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "locale" varchar(5);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancel_reason" varchar(20);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancel_note" varchar(255);

-- Every storefront order was placed when it was created (nothing has moved a
-- created_at yet); from now on completion moves created_at, placed_at stays.
UPDATE "orders" SET "placed_at" = "created_at"
 WHERE "source" = 'store' AND "placed_at" IS NULL;

UPDATE "orders" SET "status" = 'Assembling', "updated_at" = now()
 WHERE "source" = 'store' AND "status" = 'Confirmed';

-- The online-orders list: one shop's storefront orders by status, oldest
-- waiting first. Partial — till sales are the bulk of the table.
CREATE INDEX IF NOT EXISTS "orders_business_store_status_idx"
  ON "orders" USING btree ("business_id","status","placed_at")
  WHERE "orders"."source" = 'store';

-- 2. Status history (Q10).
CREATE TABLE IF NOT EXISTS "order_status_events" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "order_id" varchar(36) NOT NULL,
  "from_status" varchar(20),
  "to_status" varchar(20) NOT NULL,
  "actor_type" varchar(10) NOT NULL,
  "actor_id" varchar(36),
  "actor_name" varchar(255),
  "courier_name" varchar(255),
  "reason" varchar(20),
  "note" varchar(255),
  "meta" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "order_status_events_order_idx" ON "order_status_events" USING btree ("order_id","created_at");

-- 3. Store fulfilment settings (Q3, Q4, Q14, Q19). Not on `businesses`: that
--    row is spread into login/profile payloads. No row = defaults.
CREATE TABLE IF NOT EXISTS "store_settings" (
  "business_id" varchar(36) PRIMARY KEY NOT NULL,
  "pickup_enabled" boolean DEFAULT true NOT NULL,
  "delivery_enabled" boolean DEFAULT true NOT NULL,
  "delivery_fee" numeric(12, 2) DEFAULT '0' NOT NULL,
  "free_delivery_from" numeric(12, 2),
  "min_delivery_amount" numeric(12, 2),
  "online_branch_id" varchar(36),
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_online_branch_id_branches_id_fk" FOREIGN KEY ("online_branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- 4. Returns: the delivery fee given back on a full return (Q27).
ALTER TABLE "sale_returns" ADD COLUMN IF NOT EXISTS "delivery_fee_refund" numeric(12, 2) DEFAULT '0' NOT NULL;

-- 5. Q21: online orders get their own permission. Whoever could change an
--    online order's status before (sale:update) keeps being able to.
UPDATE "roles"
   SET "permissions" = "permissions" || '["sale:online:manage"]'::jsonb,
       "updated_at" = now()
 WHERE "permissions" ? 'sale:update'
   AND NOT ("permissions" ? 'sale:online:manage');

-- 6. The assistant's read-only role sees the new tenant tables like every
--    other one (0062 §2).
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pimpo_ai_ro') THEN
    FOREACH t IN ARRAY ARRAY['order_status_events', 'store_settings'] LOOP
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
