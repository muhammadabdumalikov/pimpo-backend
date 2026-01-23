import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { users, type User, type NewUser } from '../database/schema';
import { eq, and, desc, ilike, or, count } from 'drizzle-orm';
import { generateId } from '../utils/uuid';

@Injectable()
export class UserService {
  constructor(private readonly dbService: DatabaseService) {}

  async create(businessId: string, data: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
  }): Promise<User> {
    // Check if user with same phone already exists for this business
    const existing = await this.dbService.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.businessId, businessId),
          eq(users.phone, data.phone),
          eq(users.isActive, true),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictException('User with this phone number already exists');
    }

    const newUser: NewUser = {
      id: generateId(),
      businessId,
      name: data.name,
      phone: data.phone,
      email: data.email || null,
      address: data.address || null,
      isActive: true,
    };

    const [user] = await this.dbService.db
      .insert(users)
      .values(newUser)
      .returning();

    return user;
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
    },
  ): Promise<{ users: User[]; total: number; page: number; limit: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;
    const search = options?.search;

    const whereConditions = [
      eq(users.businessId, businessId),
      eq(users.isActive, true),
    ];

    if (search) {
      whereConditions.push(
        or(
          ilike(users.name, `%${search}%`),
          ilike(users.phone, `%${search}%`),
          ilike(users.email, `%${search}%`),
        )!,
      );
    }

    // Get total count
    const totalResult = await this.dbService.db
      .select({ count: count() })
      .from(users)
      .where(and(...whereConditions));
    const total = totalResult[0].count;

    // Get paginated results
    const paginatedUsers = await this.dbService.db
      .select()
      .from(users)
      .where(and(...whereConditions))
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      users: paginatedUsers,
      total,
      page,
      limit,
    };
  }

  async findOne(businessId: string, userId: string): Promise<User | null> {
    const [user] = await this.dbService.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.businessId, businessId),
          eq(users.isActive, true),
        ),
      )
      .limit(1);

    return user || null;
  }

  async findByPhone(businessId: string, phone: string): Promise<User | null> {
    const [user] = await this.dbService.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.businessId, businessId),
          eq(users.phone, phone),
          eq(users.isActive, true),
        ),
      )
      .limit(1);

    return user || null;
  }

  async update(
    businessId: string,
    userId: string,
    data: Partial<Omit<NewUser, 'id' | 'businessId' | 'createdAt'>>,
  ): Promise<User> {
    const existing = await this.findOne(businessId, userId);
    if (!existing) {
      throw new NotFoundException('User not found');
    }

    // Check if phone is being updated and conflicts with another user
    if (data.phone && data.phone !== existing.phone) {
      const phoneExists = await this.dbService.db
        .select()
        .from(users)
        .where(
          and(
            eq(users.businessId, businessId),
            eq(users.phone, data.phone),
            eq(users.isActive, true),
          ),
        )
        .limit(1);

      if (phoneExists.length > 0) {
        throw new ConflictException('User with this phone number already exists');
      }
    }

    const [user] = await this.dbService.db
      .update(users)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(users.id, userId),
          eq(users.businessId, businessId),
        ),
      )
      .returning();

    return user;
  }

  async remove(businessId: string, userId: string): Promise<void> {
    const existing = await this.findOne(businessId, userId);
    if (!existing) {
      throw new NotFoundException('User not found');
    }

    // Soft delete
    await this.dbService.db
      .update(users)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(users.id, userId),
          eq(users.businessId, businessId),
        ),
      );
  }

  async getCount(businessId: string): Promise<number> {
    const result = await this.dbService.db
      .select({ count: count() })
      .from(users)
      .where(
        and(
          eq(users.businessId, businessId),
          eq(users.isActive, true),
        ),
      );

    return result[0].count;
  }
}
