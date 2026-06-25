import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { categories, type Category, type NewCategory } from '../database/schema';
import { eq, and, asc } from 'drizzle-orm';

@Injectable()
export class CategoryService {
  constructor(private readonly dbService: DatabaseService) {}

  async create(businessId: string, data: { id: string; name: string; image?: string }): Promise<Category> {
    const existing = await this.dbService.db
      .select()
      .from(categories)
      .where(and(
        eq(categories.businessId, businessId),
        eq(categories.id, data.id),
        eq(categories.isDeleted, false),
      ))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException('Category with this id already exists');
    }
    const newCat: NewCategory = {
      id: data.id,
      businessId,
      name: data.name,
      image: data.image ?? null,
      isDeleted: false,
    };
    const [cat] = await this.dbService.db.insert(categories).values(newCat).returning();
    return cat;
  }

  async findAll(businessId: string): Promise<Category[]> {
    return this.dbService.db
      .select()
      .from(categories)
      .where(and(eq(categories.businessId, businessId), eq(categories.isDeleted, false)))
      .orderBy(asc(categories.name));
  }

  async findOne(businessId: string, categoryId: string): Promise<Category | null> {
    const [cat] = await this.dbService.db
      .select()
      .from(categories)
      .where(and(
        eq(categories.businessId, businessId),
        eq(categories.id, categoryId),
        eq(categories.isDeleted, false),
      ))
      .limit(1);
    return cat ?? null;
  }

  async update(
    businessId: string,
    categoryId: string,
    data: { name?: string; image?: string },
  ): Promise<Category> {
    const existing = await this.findOne(businessId, categoryId);
    if (!existing) {
      throw new NotFoundException('Category not found');
    }
    const [cat] = await this.dbService.db
      .update(categories)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.image !== undefined && { image: data.image }),
        updatedAt: new Date(),
      })
      .where(and(eq(categories.businessId, businessId), eq(categories.id, categoryId)))
      .returning();
    return cat;
  }

  async remove(businessId: string, categoryId: string): Promise<void> {
    const existing = await this.findOne(businessId, categoryId);
    if (!existing) {
      throw new NotFoundException('Category not found');
    }
    await this.dbService.db
      .update(categories)
      .set({ isDeleted: true, updatedAt: new Date() })
      .where(and(eq(categories.businessId, businessId), eq(categories.id, categoryId)));
  }

  async findAllForStore(businessId?: string): Promise<Category[]> {
    const notDeleted = eq(categories.isDeleted, false);
    if (businessId) {
      return this.dbService.db
        .select()
        .from(categories)
        .where(and(eq(categories.businessId, businessId), notDeleted))
        .orderBy(asc(categories.name));
    }
    return this.dbService.db
      .select()
      .from(categories)
      .where(notDeleted)
      .orderBy(asc(categories.name));
  }
}
