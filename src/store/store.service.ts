import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { products, type Product } from '../database/schema';
import { eq, and, desc, count } from 'drizzle-orm';

@Injectable()
export class StoreService {
  constructor(private readonly dbService: DatabaseService) {}

  async findAll(options?: {
    category?: string;
    page?: number;
    limit?: number;
  }): Promise<{ products: Product[]; total: number; page: number; limit: number }> {
    const page = options?.page || 1;
    const limit = Math.min(options?.limit || 100, 100);
    const offset = (page - 1) * limit;
    const category = options?.category;

    const conditions = [eq(products.isActive, true)];
    if (category) {
      conditions.push(eq(products.categoryId, category));
    }

    const totalResult = await this.dbService.db
      .select({ count: count() })
      .from(products)
      .where(and(...conditions));
    const total = totalResult[0]?.count ?? 0;

    const list = await this.dbService.db
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(desc(products.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      products: list,
      total,
      page,
      limit,
    };
  }

  async findOne(id: string): Promise<Product> {
    const [product] = await this.dbService.db
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.isActive, true)))
      .limit(1);

    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }
}
