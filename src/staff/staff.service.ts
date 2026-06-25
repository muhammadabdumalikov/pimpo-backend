import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, asc } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { staff, roles, type Staff, type NewStaff } from '../database/schema';
import { generateId } from '../utils/uuid';
import { hashPassword } from '../utils/password';

export type StaffView = Omit<Staff, 'password'> & { roleName: string | null };

@Injectable()
export class StaffService {
  constructor(private readonly dbService: DatabaseService) {}

  private strip(member: Staff, roleName: string | null): StaffView {
    const { password: _, ...rest } = member;
    return { ...rest, roleName };
  }

  async findAll(businessId: string): Promise<StaffView[]> {
    const rows = await this.dbService.db
      .select()
      .from(staff)
      .leftJoin(roles, eq(staff.roleId, roles.id))
      .where(eq(staff.businessId, businessId))
      .orderBy(asc(staff.name));

    return rows.map((row) => this.strip(row.staff, row.roles?.name ?? null));
  }

  async findOne(businessId: string, id: string): Promise<StaffView | null> {
    const [row] = await this.dbService.db
      .select()
      .from(staff)
      .leftJoin(roles, eq(staff.roleId, roles.id))
      .where(and(eq(staff.businessId, businessId), eq(staff.id, id)))
      .limit(1);
    if (!row) return null;
    return this.strip(row.staff, row.roles?.name ?? null);
  }

  private async assertRoleBelongsToBusiness(businessId: string, roleId: string) {
    const [role] = await this.dbService.db
      .select()
      .from(roles)
      .where(and(eq(roles.businessId, businessId), eq(roles.id, roleId)))
      .limit(1);
    if (!role) {
      throw new BadRequestException('Role not found for this business');
    }
  }

  async create(
    businessId: string,
    data: { name: string; login: string; password: string; roleId: string },
  ): Promise<StaffView> {
    await this.assertRoleBelongsToBusiness(businessId, data.roleId);

    const [existing] = await this.dbService.db
      .select()
      .from(staff)
      .where(eq(staff.login, data.login))
      .limit(1);
    if (existing) {
      throw new ConflictException('Login already exists');
    }

    const newStaff: NewStaff = {
      id: generateId(),
      businessId,
      roleId: data.roleId,
      name: data.name,
      login: data.login,
      password: hashPassword(data.password),
      isActive: true,
    };
    const [created] = await this.dbService.db
      .insert(staff)
      .values(newStaff)
      .returning();
    return this.strip(created, null);
  }

  async update(
    businessId: string,
    id: string,
    data: { name?: string; roleId?: string; password?: string; isActive?: boolean },
  ): Promise<StaffView> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new NotFoundException('Staff not found');
    }
    if (data.roleId) {
      await this.assertRoleBelongsToBusiness(businessId, data.roleId);
    }

    await this.dbService.db
      .update(staff)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.roleId !== undefined && { roleId: data.roleId }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.password !== undefined && {
          password: hashPassword(data.password),
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(staff.businessId, businessId), eq(staff.id, id)));

    return (await this.findOne(businessId, id)) as StaffView;
  }

  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new NotFoundException('Staff not found');
    }
    await this.dbService.db
      .delete(staff)
      .where(and(eq(staff.businessId, businessId), eq(staff.id, id)));
  }
}
