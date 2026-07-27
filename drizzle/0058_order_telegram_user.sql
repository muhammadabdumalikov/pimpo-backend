-- Telegram Mini App storefront: bind a store order to the Telegram user who
-- placed it.
--
-- The mini app runs in a webview whose localStorage is not durable, so the
-- customer's order history cannot live in the browser alone. The verified
-- Telegram user id is also the chat the bot DMs status changes to.
-- Null for every plain-web order (and every row before this migration).

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "telegram_user_id" varchar(32);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_business_telegram_idx" ON "orders" ("business_id","telegram_user_id","created_at");
