-- The owner's contact phone, asked at sign-up. A new shop starts its trial and
-- often leaves before setting anything up; with a number on file the team can
-- call and help.
--
-- Idempotent; additive only. Nullable: every shop registered before this has
-- no number, and the platform console may still create one without it. Stored
-- as "+998" and nine digits (see common/phone.ts). Not unique: one person may
-- own several shops.

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "phone" varchar(32);
