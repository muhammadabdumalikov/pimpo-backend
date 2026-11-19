-- KPOS iPhone app (pimpo/IOS.md, stage 1): native push through APNs.
--
-- Idempotent; safe to re-run. Additive only — the running code ignores it.
--
--   apns_devices   one row per iPhone app install of a business owner: the
--                  APNs device token, the APNs host it belongs to (sandbox for
--                  debug builds, production for TestFlight/App Store) and the
--                  language for the texts. The twin of push_subscriptions
--                  (web push); both get the same events.
CREATE TABLE IF NOT EXISTS "apns_devices" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "token" varchar(200) NOT NULL,
  "environment" varchar(16) DEFAULT 'production' NOT NULL,
  "locale" varchar(8) DEFAULT 'uz' NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "last_success_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "apns_devices" ADD CONSTRAINT "apns_devices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "apns_devices_token_uq" ON "apns_devices" USING btree ("token");
CREATE INDEX IF NOT EXISTS "apns_devices_business_idx" ON "apns_devices" USING btree ("business_id");
