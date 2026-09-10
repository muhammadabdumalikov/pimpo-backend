import {readFileSync, readdirSync, statSync} from 'fs';
import {join} from 'path';
import {PERMISSION_CATALOG, PERMISSION_KEYS} from './permission.catalog';

/** Every .ts file under src/, except the catalogue and this spec itself. */
function sourceFiles(dir = join(__dirname, '..')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (
      entry.endsWith('.ts') &&
      !entry.startsWith('permission.catalog')
    ) {
      out.push(path);
    }
  }
  return out;
}

const CODE = sourceFiles()
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('permission catalogue', () => {
  it('has no duplicate keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('uses the resource:action shape throughout', () => {
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z]+(:[a-z]+)+$/);
    }
  });

  // The catalogue's first rule, made mechanical: a key a shop can tick must
  // actually refuse something. A checkbox that guards nothing is worse than no
  // checkbox — it tells an owner they are protected when they are not.
  it('enforces every key it offers', () => {
    const unenforced = PERMISSION_KEYS.filter(
      (key) =>
        !CODE.includes(`RequirePermission('${key}')`) &&
        !CODE.includes(`assert(account, '${key}')`) &&
        !CODE.includes(`can(account, '${key}')`),
    );
    expect(unenforced).toEqual([]);
  });

  it('groups every key', () => {
    for (const def of PERMISSION_CATALOG) {
      expect(def.group).toBeTruthy();
    }
  });
});
