import {Injectable} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {eq, and, asc, ne} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  staff,
  roles,
  branches,
  type Staff,
  type NewStaff,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {hashPassword} from '../utils/password';
import {SubscriptionService} from '../subscription/subscription.service';

export type StaffView = Omit<Staff, 'password'> & {
  roleName: string | null;
  branchName: string | null;
};

/** Salary shapes an employee can be paid on. */
export type SalaryType = 'none' | 'fixed' | 'percent' | 'mixed';

export interface StaffWriteData {
  name: string;
  hasAccount?: boolean;
  login?: string | null;
  password?: string | null;
  roleId?: string | null;
  position?: string | null;
  phone?: string | null;
  branchId?: string | null;
  hiredAt?: string | null;
  salaryType?: SalaryType;
  baseSalary?: number;
  salesPercent?: number;
  percentBase?: 'revenue' | 'profit';
  isActive?: boolean;
}

@Injectable()
export class StaffService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * Seats consumed by staff. Only employees who can actually sign in count —
   * an accountless payroll record (cleaner, warehouse hand) is free, which is
   * the whole point of separating "employee" from "user".
   *
   * `excludeId` lets an update re-check the limit without counting the row
   * being edited, since that row is about to be replaced by the new state.
   */
  private async countAccountHolders(
    businessId: string,
    excludeId?: string,
  ): Promise<number> {
    const rows = await this.db
      .select({id: staff.id})
      .from(staff)
      .where(
        and(
          eq(staff.businessId, businessId),
          eq(staff.isActive, true),
          eq(staff.hasAccount, true),
          ...(excludeId ? [ne(staff.id, excludeId)] : []),
        ),
      );
    return rows.length;
  }

  /**
   * Throws if granting one more account would exceed the plan. The owner always
   * holds one seat, so usersLimit N allows N-1 account-holding staff.
   */
  private async assertSeatAvailable(
    businessId: string,
    excludeId?: string,
  ): Promise<void> {
    const {usersLimit} =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    if (usersLimit === null) return;
    const used = await this.countAccountHolders(businessId, excludeId);
    // +1 for the owner's seat, +1 for the account about to be granted.
    if (used + 2 > usersLimit) {
      throw new AppException(ErrorCode.USER_LIMIT_REACHED, {limit: usersLimit});
    }
  }

  private strip(
    member: Staff,
    roleName: string | null,
    branchName: string | null,
  ): StaffView {
    const {password: _, ...rest} = member;
    return {...rest, roleName, branchName};
  }

  async findAll(businessId: string): Promise<StaffView[]> {
    const rows = await this.db
      .select()
      .from(staff)
      .leftJoin(roles, eq(staff.roleId, roles.id))
      .leftJoin(branches, eq(staff.branchId, branches.id))
      .where(eq(staff.businessId, businessId))
      .orderBy(asc(staff.name));

    return rows.map((row) =>
      this.strip(row.staff, row.roles?.name ?? null, row.branches?.name ?? null),
    );
  }

  async findOne(businessId: string, id: string): Promise<StaffView | null> {
    const [row] = await this.db
      .select()
      .from(staff)
      .leftJoin(roles, eq(staff.roleId, roles.id))
      .leftJoin(branches, eq(staff.branchId, branches.id))
      .where(and(eq(staff.businessId, businessId), eq(staff.id, id)))
      .limit(1);
    if (!row) return null;
    return this.strip(
      row.staff,
      row.roles?.name ?? null,
      row.branches?.name ?? null,
    );
  }

  private async assertRoleBelongsToBusiness(businessId: string, roleId: string) {
    const [role] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.businessId, businessId), eq(roles.id, roleId)))
      .limit(1);
    if (!role) {
      throw new AppException(ErrorCode.STAFF_ROLE_NOT_FOUND);
    }
  }

  private async assertLoginFree(login: string, excludeId?: string) {
    const [existing] = await this.db
      .select({id: staff.id})
      .from(staff)
      .where(eq(staff.login, login))
      .limit(1);
    if (existing && existing.id !== excludeId) {
      throw new AppException(ErrorCode.STAFF_LOGIN_EXISTS);
    }
  }

  /**
   * Payroll columns shared by create and update. A 'percent'-only employee has
   * no fixed wage and a 'fixed' one has no percentage, so the irrelevant side is
   * zeroed here — otherwise a stale value from an earlier salary type would
   * silently show up in the next accrual.
   */
  private salaryColumns(data: Partial<StaffWriteData>, current: SalaryType) {
    const salaryType = data.salaryType ?? current;
    const keepsBase = salaryType === 'fixed' || salaryType === 'mixed';
    const keepsPercent = salaryType === 'percent' || salaryType === 'mixed';

    return {
      ...(data.salaryType !== undefined && {salaryType}),
      ...((data.baseSalary !== undefined || data.salaryType !== undefined) && {
        baseSalary: String(keepsBase ? (data.baseSalary ?? 0) : 0),
      }),
      ...((data.salesPercent !== undefined || data.salaryType !== undefined) && {
        salesPercent: String(keepsPercent ? (data.salesPercent ?? 0) : 0),
      }),
      ...(data.percentBase !== undefined && {percentBase: data.percentBase}),
      ...(data.position !== undefined && {position: data.position || null}),
      ...(data.phone !== undefined && {phone: data.phone || null}),
      ...(data.branchId !== undefined && {branchId: data.branchId || null}),
      ...(data.hiredAt !== undefined && {
        hiredAt: data.hiredAt ? new Date(data.hiredAt) : null,
      }),
    };
  }

  async create(businessId: string, data: StaffWriteData): Promise<StaffView> {
    const hasAccount = data.hasAccount ?? false;

    if (hasAccount) {
      if (!data.login || !data.password || !data.roleId) {
        throw new AppException(ErrorCode.STAFF_ACCOUNT_FIELDS_REQUIRED);
      }
      await this.assertSeatAvailable(businessId);
      await this.assertRoleBelongsToBusiness(businessId, data.roleId);
      await this.assertLoginFree(data.login);
    }

    const salaryType = data.salaryType ?? 'none';
    const newStaff: NewStaff = {
      id: generateId(),
      businessId,
      name: data.name,
      hasAccount,
      roleId: hasAccount ? (data.roleId as string) : null,
      login: hasAccount ? (data.login as string) : null,
      password: hasAccount ? hashPassword(data.password as string) : null,
      isActive: data.isActive ?? true,
      salaryType,
      ...this.salaryColumns({...data, salaryType}, salaryType),
    };

    const [created] = await this.db.insert(staff).values(newStaff).returning();
    return (await this.findOne(businessId, created.id)) as StaffView;
  }

  async update(
    businessId: string,
    id: string,
    data: Partial<StaffWriteData>,
  ): Promise<StaffView> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new AppException(ErrorCode.STAFF_NOT_FOUND);
    }

    // Resolve the account state this update lands on.
    const hasAccount = data.hasAccount ?? existing.hasAccount;
    const gainingAccount = hasAccount && !existing.hasAccount;

    const accountColumns: Partial<NewStaff> = {};

    if (hasAccount) {
      const login = data.login ?? existing.login;
      const roleId = data.roleId ?? existing.roleId;
      // A brand-new account must arrive with a password; an existing one keeps
      // its stored hash unless a new password was supplied.
      if (!login || !roleId || (gainingAccount && !data.password)) {
        throw new AppException(ErrorCode.STAFF_ACCOUNT_FIELDS_REQUIRED);
      }
      if (gainingAccount) {
        await this.assertSeatAvailable(businessId, id);
      }
      await this.assertRoleBelongsToBusiness(businessId, roleId);
      await this.assertLoginFree(login, id);

      accountColumns.hasAccount = true;
      accountColumns.login = login;
      accountColumns.roleId = roleId;
      if (data.password) {
        accountColumns.password = hashPassword(data.password);
      }
    } else {
      // Revoking access: clear the credentials so the login lookup can never
      // match this row again, and free the seat.
      accountColumns.hasAccount = false;
      accountColumns.login = null;
      accountColumns.password = null;
      accountColumns.roleId = null;
    }

    await this.db
      .update(staff)
      .set({
        ...(data.name !== undefined && {name: data.name}),
        ...(data.isActive !== undefined && {isActive: data.isActive}),
        ...accountColumns,
        ...this.salaryColumns(data, existing.salaryType as SalaryType),
        updatedAt: new Date(),
      })
      .where(and(eq(staff.businessId, businessId), eq(staff.id, id)));

    return (await this.findOne(businessId, id)) as StaffView;
  }

  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new AppException(ErrorCode.STAFF_NOT_FOUND);
    }
    await this.db
      .delete(staff)
      .where(and(eq(staff.businessId, businessId), eq(staff.id, id)));
  }

  /** Seat usage for the UI ("3 / 10 hisob ishlatilgan"). */
  async getSeatUsage(
    businessId: string,
  ): Promise<{used: number; limit: number | null}> {
    const {usersLimit} =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    // +1 for the owner, who always holds a seat.
    const used = (await this.countAccountHolders(businessId)) + 1;
    return {used, limit: usersLimit};
  }
}
