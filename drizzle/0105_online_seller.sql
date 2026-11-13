-- Online seller (ONLAYN-SOTUVCHI.md): orders taken before the goods exist,
-- deposits ("zaklad"), light variants and cargo landed cost.
--
-- Idempotent; additive only. Every new column is nullable or has a constant
-- default (metadata-only in Postgres 11+, no table rewrite), so the running
-- code keeps working and no existing row needs a backfill: stock_pending=false
-- says "already drawn", which is true of every line written before this.

-- 1. Order lines: drawn from stock later (Q1–Q2) + the buyer's choices (Q8).
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "stock_pending" boolean DEFAULT false NOT NULL;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "options" jsonb;

-- 2. Orders: deposits cache + where a hand-made order came from.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "prepaid_amount" numeric(12, 2) DEFAULT '0' NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "channel" varchar(12);

-- 3. Money taken on an order (deposit / balance / refund), booked into Moliya.
CREATE TABLE IF NOT EXISTS "order_payments" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "order_id" varchar(36) NOT NULL,
  "kind" varchar(10) NOT NULL,
  "amount" numeric(12, 2) NOT NULL,
  "method" varchar(50) NOT NULL,
  "account_id" varchar(36),
  "account_name" varchar(255),
  "finance_tx_id" varchar(36),
  "actor_id" varchar(36),
  "actor_name" varchar(255),
  "note" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "order_payments_order_idx" ON "order_payments" USING btree ("order_id","created_at");
CREATE INDEX IF NOT EXISTS "order_payments_business_created_idx" ON "order_payments" USING btree ("business_id","created_at");

-- 4. Product cards: "Buyurtmaga olinadi", choices, lead time, description.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "preorder" boolean DEFAULT false NOT NULL;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "options" jsonb;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "lead_time" varchar(60);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "description" text;

-- 5. Goods receipts: cargo spread into the lines' cost (Q9).
ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "extra_cost" numeric(12, 2) DEFAULT '0' NOT NULL;

-- 6. The assistant's read-only role sees the new tenant table like every
--    other one (0062 §2).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pimpo_ai_ro') THEN
    ALTER TABLE public.order_payments ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS ai_ro_tenant ON public.order_payments;
    CREATE POLICY ai_ro_tenant ON public.order_payments FOR SELECT TO pimpo_ai_ro
      USING (business_id = (SELECT nullif(current_setting('app.business_id', true), '')));
    GRANT SELECT ON public.order_payments TO pimpo_ai_ro;
  END IF;
END $$;
