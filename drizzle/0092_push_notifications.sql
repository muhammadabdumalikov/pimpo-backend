-- Owner phone UI (MOBILE.md §9, §11 B2): web push + the 🔔 inbox, and the
-- events added to the shared Telegram/push toggle list.
--
-- Idempotent; safe to re-run. Additive only — the running code ignores all of it.
--
--   telegram_notification_settings  four new toggles (default ON). One list
--                                   drives both channels: Telegram and push.
--   push_subscriptions              one row per installed phone (browser push
--                                   endpoint) of a business owner.
--   notifications                   the inbox: every event that passed its
--                                   toggle; pruned after 30 days.
--   announcements.pushed_at         when the phone push for it went out. Every
--                                   announcement already live is stamped now,
--                                   so the first deploy doesn't re-push old news.
ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "online_orders" boolean DEFAULT true NOT NULL;
ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "suspicious" boolean DEFAULT true NOT NULL;
ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "low_stock" boolean DEFAULT true NOT NULL;
ALTER TABLE "telegram_notification_settings" ADD COLUMN IF NOT EXISTS "announcements" boolean DEFAULT true NOT NULL;

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "endpoint" text NOT NULL,
  "p256dh" varchar(255) NOT NULL,
  "auth" varchar(255) NOT NULL,
  "locale" varchar(8) DEFAULT 'uz' NOT NULL,
  "user_agent" varchar(500),
  "failure_count" integer DEFAULT 0 NOT NULL,
  "last_success_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");
CREATE INDEX IF NOT EXISTS "push_subscriptions_business_idx" ON "push_subscriptions" USING btree ("business_id");

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "event" varchar(32) NOT NULL,
  "data" jsonb NOT NULL,
  "read_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "notifications_business_created_idx" ON "notifications" USING btree ("business_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "notifications_business_unread_idx" ON "notifications" USING btree ("business_id") WHERE "read_at" IS NULL;

ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "pushed_at" timestamp;
UPDATE "announcements" SET "pushed_at" = now()
 WHERE "pushed_at" IS NULL AND "published_at" IS NOT NULL AND "published_at" <= now();
