-- Daily sales digest schedule: the owner picks when the Telegram digest is
-- sent and which hours it covers (was a fixed 21:00 "day so far").
--
-- Idempotent; additive only — defaulted/nullable columns the running code
-- never reads. Defaults reproduce the old behaviour.

ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "daily_sales_send_at" varchar(5) DEFAULT '21:00' NOT NULL;
ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "daily_sales_from" varchar(5) DEFAULT '00:00' NOT NULL;
ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "daily_sales_to" varchar(5) DEFAULT '21:00' NOT NULL;
ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "daily_sales_last_sent_at" timestamp;
