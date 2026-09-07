/**
 * The canonical list of ACTION permissions.
 *
 * Two hard rules:
 *  1. A key lands here only once it is actually ENFORCED on the server. A
 *     checkbox in the roles UI that refuses nothing is worse than no checkbox.
 *  2. Keys are `resource:action`, lowercase, stable forever — they are stored
 *     verbatim in roles.permissions, so renaming one is a data migration.
 *
 * Not expressed here (deliberately):
 *  • Subscription tier — a BUSINESS-level gate, handled by PlanTierGuard.
 *  • Data scope ("only own branch / own sales") — that is a row filter, not an
 *    action. It gets its own field on the role when we need it; folding it in
 *    here would multiply every key by three.
 */
export interface PermissionDefinition {
  key: string;
  /** Grouping for the roles UI. */
  group: 'procurement' | 'team';
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  // Applying a goods receipt (nakladnoy) to stock. Covers every path that
  // turns supplier goods into inventory: receiving a draft, creating an
  // already-received receipt, and amending a received one.
  {key: 'receipt:receive', group: 'procurement'},

  // Team. Reading the employee ROSTER (names, positions, branches) needs no
  // permission — the sales and finance filters list colleagues by name and
  // every till uses them. These three cover what the roster deliberately
  // leaves out.
  //   staff:read          the full employee record: login, role, phone, hire date
  //   staff:payroll:view  the wage fields on it (salary type, oklad, percent)
  //   staff:manage        creating, editing and deleting employees
  //   role:manage         creating, editing and deleting roles
  // The last two were owner-only until now and stay that way in practice: no
  // existing role is granted them, so an owner has to hand them out on purpose.
  {key: 'staff:read', group: 'team'},
  {key: 'staff:payroll:view', group: 'team'},
  {key: 'staff:manage', group: 'team'},
  {key: 'role:manage', group: 'team'},
] as const;

export const PERMISSION_KEYS: readonly string[] = PERMISSION_CATALOG.map(
  (p) => p.key,
);

/** Owner sentinel: the business owner holds every permission, present and future. */
export const ALL_PERMISSIONS = '*';

export function isKnownPermission(key: string): boolean {
  return PERMISSION_KEYS.includes(key);
}
