-- Fast-food mode (FASTFOOD.md, F1): business type, dish/semi cards with
-- recipes, a daily queue number, service type and kitchen notes on sales.
--
-- Idempotent; safe to re-run. Additive only — every new column has a default
-- (or is nullable) that keeps retail behaviour exactly as it was, so the
-- running code ignores all of it.
--
--   businesses.business_type     'retail' (default) | 'food'
--   products.kind                'stock' (default) | 'dish' | 'semi'
--   products.show_in_menu        stock card shown on the fast-food till
--   products.recipe_yield        semi: how much one recipe batch makes
--   orders.queue_no              daily queue number (food sales only)
--   orders.service_type          'dine_in' | 'takeaway' (food sales only)
--   order_items.note             kitchen note for the line
--   recipe_items                 recipe lines (dish/semi → component)
--   order_item_components        what a sold dish line drew, per ingredient
--   queue_sequences              per-business daily counter for queue_no
--   food_settings                note presets, food-cost target
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "business_type" varchar(10) DEFAULT 'retail' NOT NULL;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "kind" varchar(8) DEFAULT 'stock' NOT NULL;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "show_in_menu" boolean DEFAULT false NOT NULL;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "recipe_yield" double precision;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "queue_no" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "service_type" varchar(10);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "note" varchar(200);

CREATE TABLE IF NOT EXISTS "recipe_items" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "product_id" varchar(36) NOT NULL,
  "component_id" varchar(36) NOT NULL,
  "quantity" double precision NOT NULL,
  "takeaway_only" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_component_id_products_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "recipe_items_product_component_uq" ON "recipe_items" USING btree ("product_id","component_id");
CREATE INDEX IF NOT EXISTS "recipe_items_business_component_idx" ON "recipe_items" USING btree ("business_id","component_id");

CREATE TABLE IF NOT EXISTS "order_item_components" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "order_id" varchar(36) NOT NULL,
  "order_item_id" varchar(36) NOT NULL,
  "product_id" varchar(36),
  "product_name" varchar(255) NOT NULL,
  "quantity" double precision NOT NULL,
  "cost_total" numeric(12, 2) DEFAULT '0' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "order_item_components" ADD CONSTRAINT "order_item_components_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "order_item_components" ADD CONSTRAINT "order_item_components_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "order_item_components" ADD CONSTRAINT "order_item_components_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "order_item_components_item_idx" ON "order_item_components" USING btree ("order_item_id");
CREATE INDEX IF NOT EXISTS "order_item_components_business_product_idx" ON "order_item_components" USING btree ("business_id","product_id");

CREATE TABLE IF NOT EXISTS "queue_sequences" (
  "business_id" varchar(36) PRIMARY KEY NOT NULL,
  "day" varchar(10) NOT NULL,
  "last_no" integer DEFAULT 0 NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "queue_sequences" ADD CONSTRAINT "queue_sequences_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "food_settings" (
  "business_id" varchar(36) PRIMARY KEY NOT NULL,
  "note_presets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "food_cost_target" numeric(5, 2) DEFAULT '35' NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "food_settings" ADD CONSTRAINT "food_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
