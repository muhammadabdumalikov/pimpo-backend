-- Recompute roles.menu_keys from roles.permissions.
--
-- menuKeys used to be a second list an owner edited by hand next to the
-- permissions, with nothing linking the two: a role could be granted every
-- action and still open to an empty sidebar with no way to reach anything.
-- The server now derives menu_keys on every role write
-- (permission/menu-derivation.ts) and ignores whatever a client sends. This
-- brings existing rows in line with that, so a role that is never edited again
-- still shows the right menus.
--
-- It matters beyond tidiness: kpos-mobile still gates its tabs on menuKeys, so
-- a stale (or empty) list is a blank app on the phone.
--
-- Keep this table in step with menu-derivation.ts. Idempotent: same
-- permissions in, same menu_keys out.
WITH map(menu_key, perm) AS (
  VALUES
    ('ecommerce.products',   'product:create'),
    ('ecommerce.products',   'product:update'),
    ('ecommerce.products',   'product:delete'),
    ('ecommerce.addProduct', 'product:create'),
    ('ecommerce.categories', 'catalog:manage'),
    ('inventory',            'stocktake:manage'),
    ('inventory',            'transfer:manage'),
    ('suppliers',            'supplier:manage'),
    ('receipts',             'receipt:read'),
    ('checkout',             'sale:create'),
    ('kassa',                'shift:open'),
    ('kassa',                'shift:close'),
    ('kassa',                'cash:movement'),
    ('customers',            'customer:read'),
    ('userDebt',             'debt:read'),
    ('loyalty',              'loyalty:manage'),
    ('finance.transactions', 'finance:read'),
    ('finance.categories',   'finance:read'),
    ('finance.state',        'finance:read'),
    ('finance.payroll',      'payroll:view'),
    ('reports',              'report:view'),
    ('reports.extended',     'report:view'),
    ('reports.multibranch',  'report:view'),
    ('productPerformance',   'report:view'),
    ('team.staff',           'staff:read'),
    ('team.roles',           'staff:read'),
    ('team.sales',           'staff:sales:view'),
    ('settings',             'settings:manage'),
    ('settings.receipts',    'settings:manage'),
    ('settings.onlineStore', 'settings:manage'),
    ('settings.telegram',    'settings:manage'),
    ('settings.labels',      'settings:manage'),
    ('settings.scales',      'settings:manage'),
    ('subscriptionManagement', 'settings:manage'),
    ('upgradePlan',          'settings:manage')
)
UPDATE "roles" r
SET "menu_keys" = (
  SELECT COALESCE(jsonb_agg(DISTINCT s.menu_key), '[]'::jsonb)
  FROM (
    -- The dashboard is a redirect target, so it must never be unreachable; the
    -- AI assistant is already restricted by subscription tier; and the profile
    -- is self-service (an account must always be able to change its password).
    SELECT unnest(ARRAY['dashboard.ecommerce', 'ai', 'settings.profile']) AS menu_key
    UNION
    SELECT m.menu_key
    FROM map m
    WHERE r."permissions" @> jsonb_build_array(m.perm)
  ) s
);
