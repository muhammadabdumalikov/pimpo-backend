import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { brands, type Brand, type NewBrand } from '../database/schema';
import { eq, and, desc, ilike } from 'drizzle-orm';
import { generateId } from '../utils/uuid';

@Injectable()
export class BrandService {
  constructor(private readonly dbService: DatabaseService) {}

  async create(businessId: string, data: { name: string }): Promise<Brand> {
    const newBrand: NewBrand = {
      id: generateId(),
      businessId,
      name: data.name,
      isActive: true,
    };

    const [brand] = await this.dbService.db
      .insert(brands)
      .values(newBrand)
      .returning();

    return brand;
  }

  async findAll(
    businessId: string,
    options?: { page?: number; limit?: number; search?: string },
  ): Promise<{ brands: Brand[]; total: number; page: number; limit: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 100;
    const offset = (page - 1) * limit;
    const search = options?.search;

    const whereConditions = [
      eq(brands.businessId, businessId),
      eq(brands.isActive, true),
    ];

    if (search) {
      whereConditions.push(ilike(brands.name, `%${search}%`));
    }

    const all = await this.dbService.db
      .select()
      .from(brands)
      .where(and(...whereConditions));
    const total = all.length;

    const paginated = await this.dbService.db
      .select()
      .from(brands)
      .where(and(...whereConditions))
      .orderBy(desc(brands.createdAt))
      .limit(limit)
      .offset(offset);

    return { brands: paginated, total, page, limit };
  }

  async findOne(businessId: string, brandId: string): Promise<Brand | null> {
    const [brand] = await this.dbService.db
      .select()
      .from(brands)
      .where(
        and(
          eq(brands.id, brandId),
          eq(brands.businessId, businessId),
          eq(brands.isActive, true),
        ),
      )
      .limit(1);

    return brand || null;
  }

  async update(
    businessId: string,
    brandId: string,
    data: Partial<Omit<NewBrand, 'id' | 'businessId' | 'createdAt'>>,
  ): Promise<Brand> {
    const existing = await this.findOne(businessId, brandId);
    if (!existing) {
      throw new NotFoundException('Brand not found');
    }

    const [brand] = await this.dbService.db
      .update(brands)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(brands.id, brandId), eq(brands.businessId, businessId)))
      .returning();

    return brand;
  }

  async remove(businessId: string, brandId: string): Promise<void> {
    const existing = await this.findOne(businessId, brandId);
    if (!existing) {
      throw new NotFoundException('Brand not found');
    }

    // Soft delete (products keep their brandId, which simply resolves to nothing).
    await this.dbService.db
      .update(brands)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(brands.id, brandId), eq(brands.businessId, businessId)));
  }
}
