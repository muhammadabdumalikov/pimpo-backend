-- Action-based permissions on roles. `menu_keys` says which SCREENS a role
-- sees (UI-only, unenforced); `permissions` says which ACTIONS it may perform
-- and IS enforced server-side by PermissionsGuard / PermissionService.
--
-- The two live side by side for now: menus keep working unchanged while
-- actions are migrated one at a time. Once every screen is derived from
-- permissions, `menu_keys` is dropped.
ALTER TABLE "roles"
  ADD COLUMN IF NOT EXISTS "permissions" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Backfill so nothing regresses on deploy: until now ANY staff account could
-- receive a goods receipt (the endpoints carried no role check at all), and in
-- practice only roles granted the "Qabullar" menu ever did. Those roles keep
-- the ability; the rest lose an access they were never meant to have.
UPDATE "roles"
SET "permissions" = '["receipt:receive"]'::jsonb
WHERE "permissions" = '[]'::jsonb
  AND "menu_keys" @> '["receipts"]'::jsonb;
