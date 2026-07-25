ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "loyalty_redeemed" numeric(12, 2) DEFAULT '0' NOT NULL;
