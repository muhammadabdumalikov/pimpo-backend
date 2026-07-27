-- Per-shop Telegram bot for the Mini App storefront.
--
-- The shop creates its own bot in BotFather and pastes the token here; that
-- token verifies mini-app launch payloads for this shop's storefront and DMs
-- its customers about their orders. Kept out of the `businesses` row on
-- purpose — that row is spread into login/profile payloads, where a bot token
-- must never appear. Shops with no row fall back to the platform bot
-- (TELEGRAM_BOT_TOKEN).

CREATE TABLE IF NOT EXISTS "store_bots" (
	"business_id" varchar(36) PRIMARY KEY NOT NULL,
	"bot_token" varchar(100) NOT NULL,
	"bot_username" varchar(64),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "store_bots" ADD CONSTRAINT "store_bots_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
