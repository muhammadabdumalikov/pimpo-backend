/**
 * The canonical list of ACTION permissions.
 *
 * Two hard rules:
 *  1. A key lands here only once it is actually ENFORCED on the server. A
 *     checkbox in the roles UI that refuses nothing is worse than no checkbox.
 *  2. Keys are `resource:action`, lowercase, stable forever — they are stored
 *     verbatim in roles.permissions, so renaming one is a data migration.
 *
 * WHAT IS DELIBERATELY NOT GATED — the shop's own reference data. Reading the
 * catalogue (products, categories, brands, units), the payment methods, the
 * branches, the registers and the receipt template is open to any signed-in
 * account, because the till, the checkout screen and half the pickers in the
 * app need it on every screen. Gating those reads would buy nothing — a
 * cashier sees the products anyway — and would break the POS for every role
 * that forgot a box. What IS gated is money, stock movement, people, and
 * anything that reveals cost or profit.
 *
 * Not expressed here (deliberately):
 *  • Subscription tier — a BUSINESS-level gate, handled by PlanTierGuard.
 *  • Data scope ("only own branch / own sales") — that is a row filter, not an
 *    action. It gets its own field on the role when we need it; folding it in
 *    here would multiply every key by three.
 *  • Field-level cost visibility on products (`priceIn`) — a redaction rather
 *    than an action, and it runs through reports, receipts and the till. It
 *    needs its own pass.
 */
export type PermissionGroup =
  | 'catalog'
  | 'sales'
  | 'procurement'
  | 'inventory'
  | 'finance'
  | 'customers'
  | 'reports'
  | 'team'
  | 'settings';

export interface PermissionDefinition {
  key: string;
  group: PermissionGroup;
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  // ── Katalog ──────────────────────────────────────────────────────────────
  // Reading products is open (the till needs it); changing them is not.
  {key: 'product:create', group: 'catalog'},
  {key: 'product:update', group: 'catalog'},
  {key: 'product:delete', group: 'catalog'},
  // Categories, brands and units — one key for all three dictionaries.
  {key: 'catalog:manage', group: 'catalog'},

  // ── Sotuv va kassa ───────────────────────────────────────────────────────
  {key: 'sale:read', group: 'sales'},
  {key: 'sale:create', group: 'sales'},
  {key: 'sale:update', group: 'sales'},
  {key: 'sale:delete', group: 'sales'},
  // Customer returns: goods back from a sold receipt, money out of the till.
  // Not granted to any role by default — the owner delegates it on purpose.
  {key: 'sale:return', group: 'sales'},
  {key: 'shift:open', group: 'sales'},
  {key: 'shift:close', group: 'sales'},
  // Cash in / cash out on an open shift — money leaving the drawer.
  {key: 'cash:movement', group: 'sales'},
  // Registers ("kassalar") and the cash-movement categories behind them.
  {key: 'register:manage', group: 'sales'},

  // ── Ta'minot ─────────────────────────────────────────────────────────────
  {key: 'receipt:read', group: 'procurement'},
  {key: 'receipt:create', group: 'procurement'},
  // Applying a goods receipt (nakladnoy) to stock. Covers every path that
  // turns supplier goods into inventory: receiving a draft, creating an
  // already-received receipt, and amending a received one.
  {key: 'receipt:receive', group: 'procurement'},
  {key: 'receipt:delete', group: 'procurement'},
  {key: 'receipt:pay', group: 'procurement'},
  {key: 'receipt:return', group: 'procurement'},
  {key: 'supplier:manage', group: 'procurement'},

  // ── Ombor ────────────────────────────────────────────────────────────────
  {key: 'stocktake:manage', group: 'inventory'},
  {key: 'transfer:manage', group: 'inventory'},

  // ── Moliya ───────────────────────────────────────────────────────────────
  {key: 'finance:read', group: 'finance'},
  {key: 'finance:manage', group: 'finance'},
  {key: 'payroll:view', group: 'finance'},
  {key: 'payroll:manage', group: 'finance'},

  // ── Mijozlar ─────────────────────────────────────────────────────────────
  {key: 'customer:read', group: 'customers'},
  {key: 'customer:manage', group: 'customers'},
  {key: 'debt:read', group: 'customers'},
  {key: 'debt:manage', group: 'customers'},
  {key: 'loyalty:manage', group: 'customers'},

  // ── Hisobotlar ───────────────────────────────────────────────────────────
  {key: 'report:view', group: 'reports'},
  // P&L lays out cost, margin and net profit — its own key, so a manager can
  // read the operational reports without seeing what the shop earns.
  {key: 'report:profit:view', group: 'reports'},

  // ── Jamoa ────────────────────────────────────────────────────────────────
  //   staff:read          the full employee record: login, role, phone, hire date
  //   staff:payroll:view  the wage fields on it (salary type, oklad, percent)
  //   staff:manage        creating, editing and deleting employees
  //   role:manage         creating, editing and deleting roles
  //   staff:sales:view    per-employee sales figures (Xodimlar sotuvi)
  // Reading the employee ROSTER (names, positions, branches) needs no
  // permission — the sales and finance filters list colleagues by name.
  {key: 'staff:read', group: 'team'},
  {key: 'staff:payroll:view', group: 'team'},
  {key: 'staff:sales:view', group: 'team'},
  {key: 'staff:manage', group: 'team'},
  {key: 'role:manage', group: 'team'},

  // ── Sozlamalar ───────────────────────────────────────────────────────────
  // One key for the whole settings surface: receipt template, payment methods,
  // units, catalog toggles, branches, scales, Telegram, AI and the storefront.
  // These are shop-wide switches — splitting them would produce a dozen keys
  // nobody hands out separately.
  {key: 'settings:manage', group: 'settings'},
] as const;

export const PERMISSION_KEYS: readonly string[] = PERMISSION_CATALOG.map(
  (p) => p.key,
);

/** Owner sentinel: the business owner holds every permission, present and future. */
export const ALL_PERMISSIONS = '*';

export function isKnownPermission(key: string): boolean {
  return PERMISSION_KEYS.includes(key);
}
