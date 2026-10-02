-- Desktop till (pimpo-desktop), phase 0: bound devices + cashier PINs.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend (the new code
-- reads these). Run with `psql -f`: `db:migrate` stops at the 0052 journal and
-- `db:push` never runs hand-written SQL.
--
--   staff.pin_hash   scrypt hash of the till PIN (utils/pin.ts). Accepted only
--                    together with a bound device's token, never by web login.
--   devices          one row per installed till PC, bound to one register.
--                    Only the sha256 of the device token is stored. A register
--                    has at most one live (not revoked) device.
--
-- See DESKTOP.md.
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "pin_hash" varchar(255);

CREATE TABLE IF NOT EXISTS "devices" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "register_id" varchar(36) NOT NULL REFERENCES "cash_registers"("id") ON DELETE CASCADE,
  "branch_id" varchar(36) REFERENCES "branches"("id") ON DELETE SET NULL,
  "name" varchar(255) NOT NULL,
  "receipt_prefix" varchar(16) NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "app_version" varchar(32),
  "last_seen_at" timestamp,
  "revoked_at" timestamp,
  "created_by" varchar(36),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "devices_token_hash_uq" ON "devices" ("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "devices_business_prefix_uq" ON "devices" ("business_id", "receipt_prefix");
CREATE UNIQUE INDEX IF NOT EXISTS "devices_active_register_uq" ON "devices" ("register_id") WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "devices_business_idx" ON "devices" ("business_id");
