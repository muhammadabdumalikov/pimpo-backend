ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "checked" boolean DEFAULT false NOT NULL;
