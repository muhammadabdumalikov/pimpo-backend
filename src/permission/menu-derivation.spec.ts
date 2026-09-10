import {readFileSync} from 'fs';
import {join} from 'path';
import {deriveMenuKeys} from './menu-derivation';
import {PERMISSION_KEYS} from './permission.catalog';

const SOURCE = readFileSync(join(__dirname, 'menu-derivation.ts'), 'utf8');

describe('deriveMenuKeys', () => {
  it('always gives the dashboard and the AI assistant', () => {
    // The dashboard is where every redirect lands: a role that cannot reach it
    // has nowhere to go at all.
    expect(deriveMenuKeys([])).toEqual([
      'dashboard.ecommerce',
      'ai',
      'settings.profile',
    ]);
  });

  it('opens the till for a cashier', () => {
    const menus = deriveMenuKeys([
      'sale:create',
      'sale:read',
      'shift:open',
      'shift:close',
      'cash:movement',
      'customer:read',
    ]);
    expect(menus).toEqual(
      expect.arrayContaining(['checkout', 'kassa', 'customers']),
    );
    // Nothing it cannot act on.
    expect(menus).not.toContain('finance.transactions');
    expect(menus).not.toContain('reports');
    expect(menus).not.toContain('team.staff');
  });

  it('treats an array as any-of', () => {
    // Warehouse: either of the two rights is enough to open Ombor.
    expect(deriveMenuKeys(['stocktake:manage'])).toContain('inventory');
    expect(deriveMenuKeys(['transfer:manage'])).toContain('inventory');
    expect(deriveMenuKeys(['product:delete'])).toContain('ecommerce.products');
  });

  it('is deterministic and duplicate-free', () => {
    const perms = ['report:view', 'settings:manage', 'report:view'];
    const once = deriveMenuKeys(perms);
    expect(deriveMenuKeys(perms)).toEqual(once);
    expect(new Set(once).size).toBe(once.length);
  });

  // A typo here would silently hide a menu forever: the permission would never
  // match, so the screen would simply never appear for anyone but the owner.
  it('maps only permissions that exist in the catalogue', () => {
    const referenced = [...SOURCE.matchAll(/'([a-z]+(?::[a-z]+)+)'/g)].map(
      (m) => m[1],
    );
    const unknown = referenced.filter((p) => !PERMISSION_KEYS.includes(p));
    expect(unknown).toEqual([]);
  });
});
