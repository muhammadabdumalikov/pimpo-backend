import {PermissionService} from './permission.service';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {IAccount} from '../business/types';

// Minimal fakes: the service only ever calls cache.wrap() and, on a miss, the
// loader it was handed. The loader's DB access is what we count.
function makeService(permissions: string[] | null) {
  const dbCalls = {count: 0};
  const row = permissions === null ? [] : [{permissions, isActive: true}];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            dbCalls.count += 1;
            return Promise.resolve(row);
          },
        }),
      }),
    }),
  };
  const store = new Map<string, unknown>();
  const cache = {
    async wrap<T>(key: string, loader: () => Promise<T>): Promise<T> {
      if (store.has(key)) return store.get(key) as T;
      const value = await loader();
      store.set(key, value);
      return value;
    },
  };
  const service = new PermissionService(
    {db} as never,
    cache as never,
  );
  return {service, dbCalls, store};
}

const owner: IAccount = {type: 'business', id: 'biz_1', businessId: 'biz_1'};
const staff = (): IAccount => ({
  type: 'staff',
  id: 'stf_1',
  businessId: 'biz_1',
  roleId: 'role_1',
});

describe('PermissionService', () => {
  it('grants the owner everything, without reading the database', async () => {
    const {service, dbCalls} = makeService([]);
    await expect(service.can(owner, 'receipt:receive')).resolves.toBe(true);
    // Even a permission that does not exist yet — the owner holds '*'.
    await expect(service.can(owner, 'anything:at:all')).resolves.toBe(true);
    expect(dbCalls.count).toBe(0);
  });

  it('allows a staff role that holds the permission', async () => {
    const {service} = makeService(['receipt:receive']);
    await expect(service.can(staff(), 'receipt:receive')).resolves.toBe(true);
  });

  it('refuses a staff role that does not, naming what is missing', async () => {
    const {service} = makeService(['product:read']);
    const account = staff();
    await expect(service.can(account, 'receipt:receive')).resolves.toBe(false);
    await expect(service.assert(account, 'receipt:receive')).rejects.toThrow(
      AppException,
    );
    await service.assert(account, 'receipt:receive').catch((err) => {
      expect((err as AppException).code).toBe(ErrorCode.PERMISSION_DENIED);
      expect((err as AppException).params?.required).toBe('receipt:receive');
    });
  });

  it('requires EVERY listed permission, not just one', async () => {
    const {service} = makeService(['receipt:receive']);
    await expect(
      service.can(staff(), 'receipt:receive', 'receipt:delete'),
    ).resolves.toBe(false);
  });

  it('grants nothing to a staff account whose role is gone', async () => {
    const {service} = makeService(null); // no row
    await expect(service.can(staff(), 'receipt:receive')).resolves.toBe(false);
  });

  it('grants nothing when the token carries no role', async () => {
    const {service, dbCalls} = makeService(['receipt:receive']);
    const noRole: IAccount = {type: 'staff', id: 'stf_2', businessId: 'biz_1'};
    await expect(service.can(noRole, 'receipt:receive')).resolves.toBe(false);
    expect(dbCalls.count).toBe(0);
  });

  it('reads the role once per request, then reuses the memo', async () => {
    const {service, dbCalls} = makeService(['receipt:receive']);
    const account = staff();
    await service.can(account, 'receipt:receive');
    await service.can(account, 'receipt:receive');
    await service.can(account, 'receipt:receive');
    expect(dbCalls.count).toBe(1);
    expect(account.permissions).toEqual(['receipt:receive']);
  });

  it('serves later requests from L1 without touching the store again', async () => {
    const {service, dbCalls, store} = makeService(['receipt:receive']);
    await service.can(staff(), 'receipt:receive'); // fresh account each time
    store.clear(); // L2 gone — L1 must still answer
    await expect(service.can(staff(), 'receipt:receive')).resolves.toBe(true);
    expect(dbCalls.count).toBe(1);
  });

  describe('assertCanGrant', () => {
    it('lets the owner grant anything', async () => {
      const {service} = makeService([]);
      await expect(
        service.assertCanGrant(owner, ['staff:manage', 'role:manage']),
      ).resolves.toBeUndefined();
    });

    it('lets a manager grant a subset of what it holds', async () => {
      const {service} = makeService(['staff:manage', 'receipt:receive']);
      await expect(
        service.assertCanGrant(staff(), ['receipt:receive']),
      ).resolves.toBeUndefined();
    });

    it('refuses a permission the granter does not hold', async () => {
      // The escalation this exists to stop: a delegated manager minting a role
      // that carries more than they do, then wearing it.
      const {service} = makeService(['staff:manage']);
      await expect(
        service.assertCanGrant(staff(), ['staff:manage', 'role:manage']),
      ).rejects.toMatchObject({
        code: ErrorCode.PERMISSION_GRANT_EXCEEDS_OWN,
        params: {excess: 'role:manage'},
      });
    });

    it('is a no-op for an empty grant', async () => {
      const {service, dbCalls} = makeService([]);
      await expect(service.assertCanGrant(staff(), [])).resolves.toBeUndefined();
      expect(dbCalls.count).toBe(0);
    });
  });

  it('drops L1 for the business when a role is edited', async () => {
    const {service, dbCalls, store} = makeService(['receipt:receive']);
    await service.can(staff(), 'receipt:receive');
    // What a role write does: del the L2 key AND drop L1. If L1 survived, the
    // next request would answer from stale memory and never reload.
    store.clear();
    service.invalidate('biz_1');
    await service.can(staff(), 'receipt:receive');
    expect(dbCalls.count).toBe(2);
  });
});
