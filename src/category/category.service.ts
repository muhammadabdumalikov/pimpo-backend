import { Injectable, NotFoundException, ConflictException, Inject } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { DatabaseService } from '../database/database.service';
import { categories, type Category, type NewCategory } from '../database/schema';
import { eq, and, asc } from 'drizzle-orm';
import { CacheKeys, TTL } from '../cache/cache.util';

@Injectable()
export class CategoryService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

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
    await this.cache.del(CacheKeys.categories(businessId));
    return cat;
  }

  async findAll(businessId: string): Promise<Category[]> {
    return this.cache.wrap(
      CacheKeys.categories(businessId),
      () =>
        this.dbService.db
          .select()
          .from(categories)
          .where(and(eq(categories.businessId, businessId), eq(categories.isDeleted, false)))
          .orderBy(asc(categories.name)),
      TTL.CATEGORIES,
    );
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
    await this.cache.del(CacheKeys.categories(businessId));
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
    await this.cache.del(CacheKeys.categories(businessId));
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
