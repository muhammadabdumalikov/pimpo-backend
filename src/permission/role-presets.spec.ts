import {isKnownPermission} from './permission.catalog';
import {CASHIER_PERMISSIONS} from './role-presets';

// Whole families a till-only account must never get: money and reports,
// people, settings, suppliers and goods receipts, catalogue edits, stock
// movement. Matched by resource prefix so a key added to one of these
// families later is caught too.
const EXCLUDED_PREFIXES = [
  'report:',
  'branch:',
  'finance:',
  'payroll:',
  'settings:',
  'staff:',
  'role:',
  'supplier:',
  'receipt:',
  'product:',
  'catalog:',
  'recipe:',
  'stocktake:',
  'transfer:',
  'defective:',
  'register:',
  'loyalty:',
];

// Single keys outside those families: refunds, editing or deleting sales,
// approving shifts, online orders, and the bundled keys the preset leaves out
// on purpose (see role-presets.ts).
const EXCLUDED_KEYS = [
  'sale:update',
  'sale:delete',
  'sale:return',
  'sale:online:manage',
  'shift:approve',
  'cash:movement',
  'debt:manage',
  'customer:manage',
  'customer:chat:reply',
];

describe('cashier permission preset', () => {
  it('uses only keys the catalogue enforces', () => {
    expect(CASHIER_PERMISSIONS.filter((k) => !isKnownPermission(k))).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(CASHIER_PERMISSIONS).size).toBe(CASHIER_PERMISSIONS.length);
  });

  it('can work the till', () => {
    expect(CASHIER_PERMISSIONS).toEqual(
      expect.arrayContaining(['sale:create', 'shift:open', 'shift:close', 'customer:read']),
    );
  });

  it('holds nothing from the excluded families', () => {
    const leaked = CASHIER_PERMISSIONS.filter(
      (k) =>
        EXCLUDED_PREFIXES.some((p) => k.startsWith(p)) ||
        EXCLUDED_KEYS.includes(k) ||
        k.endsWith(':delete'),
    );
    expect(leaked).toEqual([]);
  });
});
