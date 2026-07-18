import {
  Injectable,
  NotFoundException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { eq, and, asc } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { roles, staff, type Role, type NewRole } from '../database/schema';
import { generateId } from '../utils/uuid';
import { CacheKeys, TTL } from '../cache/cache.util';

@Injectable()
export class RoleService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

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
    data: { name: string; menuKeys: string[] },
  ): Promise<Role> {
    const [existing] = await this.dbService.db
      .select()
      .from(roles)
      .where(and(eq(roles.businessId, businessId), eq(roles.name, data.name)))
      .limit(1);
    if (existing) {
      throw new ConflictException('A role with this name already exists');
    }

    const newRole: NewRole = {
      id: generateId(),
      businessId,
      name: data.name,
      menuKeys: data.menuKeys ?? [],
      isActive: true,
    };
    const [role] = await this.dbService.db
      .insert(roles)
      .values(newRole)
      .returning();
    await this.cache.del(CacheKeys.roles(businessId));
    return role;
  }

  async update(
    businessId: string,
    id: string,
    data: { name?: string; menuKeys?: string[]; isActive?: boolean },
  ): Promise<Role> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new NotFoundException('Role not found');
    }

    if (data.name && data.name !== existing.name) {
      const [clash] = await this.dbService.db
        .select()
        .from(roles)
        .where(and(eq(roles.businessId, businessId), eq(roles.name, data.name)))
        .limit(1);
      if (clash) {
        throw new ConflictException('A role with this name already exists');
      }
    }

    const [role] = await this.dbService.db
      .update(roles)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.menuKeys !== undefined && { menuKeys: data.menuKeys }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        updatedAt: new Date(),
      })
      .where(and(eq(roles.businessId, businessId), eq(roles.id, id)))
      .returning();
    await this.cache.del(CacheKeys.roles(businessId));
    return role;
  }

  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new NotFoundException('Role not found');
    }

    const [assigned] = await this.dbService.db
      .select()
      .from(staff)
      .where(and(eq(staff.businessId, businessId), eq(staff.roleId, id)))
      .limit(1);
    if (assigned) {
      throw new ConflictException(
        'Cannot delete a role that is still assigned to staff',
      );
    }

    await this.dbService.db
      .delete(roles)
      .where(and(eq(roles.businessId, businessId), eq(roles.id, id)));
    await this.cache.del(CacheKeys.roles(businessId));
  }
}
