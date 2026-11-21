import {OnboardingService} from './onboarding.service';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {CASHIER_PERMISSIONS} from '../permission/role-presets';
import type {IBusiness} from '../business/types';

type RoleRow = {id: string; name: string; isActive: boolean};

// OnboardingService.addCashier with its collaborators stubbed: the role lookup
// is the only query it runs itself.
function setup(roleRows: RoleRow[][] = [[]]) {
  let call = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(roleRows[Math.min(call++, roleRows.length - 1)]),
        }),
      }),
    }),
  };
  const roleService = {
    create: jest.fn(async (_b: string, d: {name: string}) => ({id: 'role-new', name: d.name})),
  };
  const staffService = {
    create: jest.fn(async (_b: string, d: {name: string; login: string}) => ({
      id: 'staff-1',
      name: d.name,
      login: d.login,
    })),
  };
  const branchService = {ensureDefault: jest.fn(async () => ({id: 'branch-main'}))};
  const service = new OnboardingService(
    {db} as never,
    {} as never,
    roleService as never,
    staffService as never,
    branchService as never,
  );
  return {service, roleService, staffService, branchService};
}

const shop = (businessType: string | null = 'retail') =>
  ({id: 'biz-1', businessType}) as unknown as IBusiness;
const dto = {name: 'Ali', login: 'ali_kassir', password: 'secret1'};

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof AppException ? e.code : String(e);
  }
  return undefined;
}

describe('setup wizard: add a cashier', () => {
  it('refuses an online seller and a kitchen before writing anything', async () => {
    for (const type of ['online', 'food']) {
      const {service, roleService, staffService} = setup();
      expect(await codeOf(service.addCashier(shop(type), dto, 'uz'))).toBe(
        ErrorCode.SETUP_STEP_NOT_AVAILABLE,
      );
      expect(roleService.create).not.toHaveBeenCalled();
      expect(staffService.create).not.toHaveBeenCalled();
    }
  });

  it('creates the role in the request language with the cashier preset', async () => {
    const {service, roleService, staffService} = setup();
    const res = await service.addCashier(shop(), dto, 'uzc');
    expect(roleService.create).toHaveBeenCalledWith('biz-1', {
      name: 'Кассир',
      permissions: [...CASHIER_PERMISSIONS],
    });
    expect(staffService.create).toHaveBeenCalledWith('biz-1', {
      name: 'Ali',
      hasAccount: true,
      login: 'ali_kassir',
      password: 'secret1',
      roleId: 'role-new',
      position: 'Кассир',
      branchId: 'branch-main',
    });
    expect(res).toEqual({
      staff: {id: 'staff-1', name: 'Ali', login: 'ali_kassir'},
      role: {id: 'role-new', name: 'Кассир'},
    });
  });

  it("reuses the shop's own cashier role, whatever its case, and never edits it", async () => {
    const {service, roleService, staffService} = setup([
      [
        {id: 'r-manager', name: 'Menejer', isActive: true},
        {id: 'r-kassir', name: 'KASSIR', isActive: true},
      ],
    ]);
    const res = await service.addCashier(shop(), dto, 'en');
    expect(roleService.create).not.toHaveBeenCalled();
    expect(staffService.create.mock.calls[0][1]).toMatchObject({
      roleId: 'r-kassir',
      position: 'KASSIR',
    });
    expect(res.role).toEqual({id: 'r-kassir', name: 'KASSIR'});
  });

  it('passes over a deactivated cashier role', async () => {
    const {service, roleService} = setup([[{id: 'r-old', name: 'Cashier', isActive: false}]]);
    await service.addCashier(shop(), dto, 'uz');
    expect(roleService.create).toHaveBeenCalledWith('biz-1', expect.objectContaining({name: 'Kassir'}));
  });

  it('takes the role a double tap made a moment ago', async () => {
    const {service, roleService, staffService} = setup([
      [],
      [{id: 'r-raced', name: 'Kassir', isActive: true}],
    ]);
    roleService.create.mockRejectedValueOnce(new AppException(ErrorCode.ROLE_NAME_EXISTS));
    const res = await service.addCashier(shop(), dto, 'uz');
    expect(res.role.id).toBe('r-raced');
    expect(staffService.create.mock.calls[0][1]).toMatchObject({roleId: 'r-raced'});
  });

  it("lets the staff path's own errors through", async () => {
    const {service, staffService} = setup();
    staffService.create.mockRejectedValueOnce(new AppException(ErrorCode.STAFF_LOGIN_EXISTS));
    expect(await codeOf(service.addCashier(shop(), dto, 'uz'))).toBe(ErrorCode.STAFF_LOGIN_EXISTS);
  });
});
