-- Backfill roles.permissions from the menu keys each role already has.
--
-- Until now menuKeys were the ONLY thing standing between a staff account and
-- an endpoint — and they never reached the server, so in practice any signed-in
-- account could call anything. Now that the action permissions are enforced,
-- every role has to be handed the rights its screens implied, or a live shop
-- would find its cashiers locked out on deploy.
--
-- The mapping below is deliberately conservative: it grants what the UI already
-- let that role DO (the buttons its screens render), never more. Rights that
-- were owner-only before this change (payroll, staff/role management, receipt
-- deletion) are NOT granted to anyone — the owner has to delegate them on
-- purpose.
--
-- Re-running is safe in the sense that it converges to the same set; note it
-- would also restore a permission an owner deliberately removed afterwards, so
-- this is a one-time migration, not a repair tool.
WITH map(menu_key, perm) AS (
  VALUES
    -- Till: sell, reopen the sales list, drop a held order, open a shift, and
    -- look customers up for loyalty/credit.
    ('checkout',              'sale:create'),
    ('checkout',              'sale:read'),
    ('checkout',              'sale:delete'),
    ('checkout',              'shift:open'),
    ('checkout',              'customer:read'),
    -- Kassa (shifts + cash operations).
    ('kassa',                 'shift:open'),
    ('kassa',                 'shift:close'),
    ('kassa',                 'cash:movement'),
    -- Dashboard widgets read sales totals and the summary reports.
    ('dashboard.ecommerce',   'sale:read'),
    ('dashboard.ecommerce',   'report:view'),
    -- Catalogue.
    ('ecommerce.products',    'product:create'),
    ('ecommerce.products',    'product:update'),
    ('ecommerce.products',    'product:delete'),
    ('ecommerce.addProduct',  'product:create'),
    ('ecommerce.categories',  'catalog:manage'),
    -- Warehouse.
    ('inventory',             'stocktake:manage'),
    ('inventory',             'transfer:manage'),
    -- Procurement. Deleting a receipt stays owner-only, as it was.
    ('suppliers',             'supplier:manage'),
    ('receipts',              'receipt:read'),
    ('receipts',              'receipt:create'),
    ('receipts',              'receipt:receive'),
    ('receipts',              'receipt:pay'),
    ('receipts',              'receipt:return'),
    -- Customers, credit, loyalty.
    ('userDebt',              'debt:read'),
    ('userDebt',              'debt:manage'),
    ('userDebt',              'customer:read'),
    ('customers',             'customer:read'),
    ('loyalty',               'customer:read'),
    ('loyalty',               'loyalty:manage'),
    -- Money.
    ('finance.transactions',  'finance:read'),
    ('finance.transactions',  'finance:manage'),
    ('finance.categories',    'finance:read'),
    ('finance.categories',    'finance:manage'),
    ('finance.state',         'finance:read'),
    -- Reports. P&L rides the "extended" menu, which is where it lived.
    ('reports',               'report:view'),
    ('reports.extended',      'report:view'),
    ('reports.extended',      'report:profit:view'),
    ('reports.multibranch',   'report:view'),
    ('productPerformance',    'report:view'),
    -- Settings screens a role could already open.
    ('settings.receipts',     'settings:manage'),
    ('settings.telegram',     'settings:manage'),
    ('settings.onlineStore',  'settings:manage')
)
UPDATE "roles" r
SET "permissions" = (
  SELECT COALESCE(jsonb_agg(DISTINCT s.perm), '[]'::jsonb)
  FROM (
    SELECT jsonb_array_elements_text(r."permissions") AS perm
    UNION
    SELECT m.perm
    FROM map m
    WHERE r."menu_keys" @> jsonb_build_array(m.menu_key)
  ) s
);
