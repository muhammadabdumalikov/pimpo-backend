import {
  Injectable,
  Inject,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { eq, and, asc } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { roles, staff, type Role, type NewRole } from '../database/schema';
import { generateId } from '../utils/uuid';
import { CacheKeys, TTL } from '../cache/cache.util';
import { PermissionService } from '../permission/permission.service';

@Injectable()
export class RoleService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * Drops every cached view of a role: the business's role list (L2), the
   * per-role permission entry (L2) and the in-process permission cache (L1).
   * A permission edit must be visible on the very next request — that is the
   * whole reason permissions are not carried in the JWT.
   */
  private async invalidate(businessId: string, roleId?: string): Promise<void> {
    await this.cache.del(CacheKeys.roles(businessId));
    if (roleId) {
      await this.cache.del(CacheKeys.rolePermissions(businessId, roleId));
    }
    this.permissionService.invalidate(businessId);
  }

  async findAll(businessId: string): Promise<Role[]> {
    return this.cache.wrap(
      CacheKeys.roles(businessId),
      () =>
        this.dbService.db
          .select()
          .from(roles)
          .where(eq(roles.businessId, businessId))
          .orderBy(asc(roles.name)),
      TTL.ROLES,
    );
  }

  async findOne(businessId: string, id: string): Promise<Role | null> {
    const [role] = await this.dbService.db
      .select()
      .from(roles)
      .where(and(eq(roles.businessId, businessId), eq(roles.id, id)))
      .limit(1);
    return role ?? null;
  }

  async create(
    businessId: string,
    data: { name: string; menuKeys: string[]; permissions?: string[] },
  ): Promise<Role> {
    const [existing] = await this.dbService.db
      .select()
      .from(roles)
      .where(and(eq(roles.businessId, businessId), eq(roles.name, data.name)))
      .limit(1);
    if (existing) {
      throw new AppException(ErrorCode.ROLE_NAME_EXISTS);
    }

    const newRole: NewRole = {
      id: generateId(),
      businessId,
      name: data.name,
      menuKeys: data.menuKeys ?? [],
      permissions: data.permissions ?? [],
      isActive: true,
    };
    const [role] = await this.dbService.db
      .insert(roles)
      .values(newRole)
      .returning();
    await this.invalidate(businessId, role.id);
    return role;
  }

  async update(
    businessId: string,
    id: string,
    data: {
      name?: string;
      menuKeys?: string[];
      permissions?: string[];
      isActive?: boolean;
    },
  ): Promise<Role> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new AppException(ErrorCode.ROLE_NOT_FOUND);
    }

    if (data.name && data.name !== existing.name) {
      const [clash] = await this.dbService.db
        .select()
        .from(roles)
        .where(and(eq(roles.businessId, businessId), eq(roles.name, data.name)))
        .limit(1);
      if (clash) {
        throw new AppException(ErrorCode.ROLE_NAME_EXISTS);
      }
    }

    const [role] = await this.dbService.db
      .update(roles)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.menuKeys !== undefined && { menuKeys: data.menuKeys }),
        ...(data.permissions !== undefined && {
          permissions: data.permissions,
        }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        updatedAt: new Date(),
      })
      .where(and(eq(roles.businessId, businessId), eq(roles.id, id)))
      .returning();
    await this.invalidate(businessId, id);
    return role;
  }

  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new AppException(ErrorCode.ROLE_NOT_FOUND);
    }

    const [assigned] = await this.dbService.db
      .select()
      .from(staff)
      .where(and(eq(staff.businessId, businessId), eq(staff.roleId, id)))
      .limit(1);
    if (assigned) {
      throw new AppException(ErrorCode.ROLE_ASSIGNED_DELETE_FORBIDDEN);
    }

    await this.dbService.db
      .delete(roles)
      .where(and(eq(roles.businessId, businessId), eq(roles.id, id)));
    await this.invalidate(businessId, id);
  }
}
