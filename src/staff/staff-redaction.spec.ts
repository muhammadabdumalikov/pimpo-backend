import {redactStaff, type StaffView} from './staff.service';

const member = {
  id: 'stf_1',
  businessId: 'biz_1',
  roleId: 'role_1',
  roleName: 'Kassir',
  name: 'Aziz',
  login: 'aziz',
  hasAccount: true,
  avatarUrl: null,
  position: 'Sotuvchi',
  phone: '+998901112233',
  branchId: 'br_1',
  branchName: 'Markaziy',
  hiredAt: null,
  salaryType: 'mixed',
  baseSalary: '3000000.00',
  salesPercent: '2.500',
  percentBase: 'revenue',
  salaryBalance: '450000.00',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as StaffView;

describe('redactStaff', () => {
  it('gives a caller without staff:read the roster only', () => {
    const view = redactStaff(member, {full: false, payroll: false}) as Record<
      string,
      unknown
    >;
    // Names are not a secret — the sales filters list colleagues by name.
    expect(view.name).toBe('Aziz');
    expect(view.position).toBe('Sotuvchi');
    expect(view.branchName).toBe('Markaziy');
    // A login is half a credential; a wage is nobody else's business.
    expect(view.login).toBeUndefined();
    expect(view.phone).toBeUndefined();
    expect(view.roleId).toBeUndefined();
    expect(view.baseSalary).toBeUndefined();
    expect(view.salesPercent).toBeUndefined();
    expect(view.salaryBalance).toBeUndefined();
  });

  it('gives staff:read the record without wages', () => {
    const view = redactStaff(member, {full: true, payroll: false}) as Record<
      string,
      unknown
    >;
    expect(view.login).toBe('aziz');
    expect(view.phone).toBe('+998901112233');
    expect(view.baseSalary).toBeUndefined();
    expect(view.salesPercent).toBeUndefined();
    expect(view.salaryType).toBeUndefined();
    expect(view.percentBase).toBeUndefined();
    // Owed wages hide with the wage itself.
    expect(view.salaryBalance).toBeUndefined();
  });

  it('gives staff:payroll:view everything', () => {
    const view = redactStaff(member, {full: true, payroll: true}) as Record<
      string,
      unknown
    >;
    expect(view.baseSalary).toBe('3000000.00');
    expect(view.salesPercent).toBe('2.500');
    expect(view.salaryBalance).toBe('450000.00');
  });

  it('never mutates the row it was handed', () => {
    redactStaff(member, {full: true, payroll: false});
    expect((member as Record<string, unknown>).baseSalary).toBe('3000000.00');
  });
});
