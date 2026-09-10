/**
 * Menu keys derived from a role's ACTION permissions.
 *
 * `roles.menu_keys` used to be a second list an owner edited by hand, next to
 * the permissions and never linked to them — so a role could be granted every
 * action and still open to an empty sidebar with no way to reach anything.
 * It is now COMPUTED here on every role write and never accepted from a client.
 *
 * It survives only because kpos-mobile still gates its tabs on menuKeys
 * (src/lib/menuKeys.ts + auth/AuthContext). The web app already derives menu
 * visibility from the permissions directly (menuPermissions.ts →
 * MENU_REQUIRED_PERMISSION), and this table is its mirror. When mobile moves
 * over, this file and the column go together.
 *
 * An array means ANY of them is enough.
 */
const MENU_REQUIRED_PERMISSION: Record<string, string | string[]> = {
  'ecommerce.products': ['product:create', 'product:update', 'product:delete'],
  'ecommerce.addProduct': 'product:create',
  'ecommerce.categories': 'catalog:manage',
  inventory: ['stocktake:manage', 'transfer:manage'],
  suppliers: 'supplier:manage',
  receipts: 'receipt:read',
  checkout: 'sale:create',
  kassa: ['shift:open', 'shift:close', 'cash:movement'],
  customers: 'customer:read',
  userDebt: 'debt:read',
  loyalty: 'loyalty:manage',
  'finance.transactions': 'finance:read',
  'finance.categories': 'finance:read',
  'finance.state': 'finance:read',
  'finance.payroll': 'payroll:view',
  reports: 'report:view',
  'reports.extended': 'report:view',
  'reports.multibranch': 'report:view',
  productPerformance: 'report:view',
  'team.staff': 'staff:read',
  'team.roles': 'staff:read',
  'team.sales': 'staff:sales:view',
  settings: 'settings:manage',
  'settings.receipts': 'settings:manage',
  'settings.onlineStore': 'settings:manage',
  'settings.telegram': 'settings:manage',
  'settings.labels': 'settings:manage',
  'settings.scales': 'settings:manage',
  subscriptionManagement: 'settings:manage',
  upgradePlan: 'settings:manage',
};

/**
 * Menus every account sees: the dashboard is the redirect target, so making it
 * deniable would leave an account with nowhere to land, and the AI assistant is
 * already restricted by subscription tier.
 */
const ALWAYS_VISIBLE = [
  'dashboard.ecommerce',
  'ai',
  // Own profile — name, avatar, password. Self-service on the server, so an
  // account must always be able to reach it; without this a cashier could not
  // change their own password.
  'settings.profile',
];

export function deriveMenuKeys(permissions: string[]): string[] {
  const held = new Set(permissions);
  const keys = [...ALWAYS_VISIBLE];
  for (const [menu, required] of Object.entries(MENU_REQUIRED_PERMISSION)) {
    const ok = Array.isArray(required)
      ? required.some((p) => held.has(p))
      : held.has(required);
    if (ok) keys.push(menu);
  }
  return keys;
}
