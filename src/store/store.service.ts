import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import { products } from '../database/schema';
import { eq, and, desc, count, inArray } from 'drizzle-orm';

// Public product shape for the storefront. Never expose the full products row:
// priceIn (cost), barcode, businessId etc. are internal.
const publicProductColumns = {
  id: products.id,
  name: products.name,
  priceOut: products.priceOut,
  image: products.image,
  categoryId: products.categoryId,
  quantity: products.quantity,
  quantityType: products.quantityType,
};

export type StorePublicProduct = {
  id: string;
  name: string;
  priceOut: string;
  image: string | null;
  categoryId: string | null;
  quantity: number;
  quantityType: string | null;
};

@Injectable()
export class StoreService {
  constructor(private readonly dbService: DatabaseService) {}

  // The business whose catalog the storefront serves. Single-tenant for now
  // (ECOMMERCE.md F3/T13 will replace this with per-business slugs).
  private get storeBusinessId(): string | null {
    return process.env.STORE_BUSINESS_ID || null;
  }

  private scopeConditions() {
    const conditions = [eq(products.isActive, true)];
    const businessId = this.storeBusinessId;
    if (businessId) {
      conditions.push(eq(products.businessId, businessId));
    }
    return conditions;
  }

  async findAll(options?: {
    category?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    products: StorePublicProduct[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = options?.page || 1;
    const limit = Math.min(options?.limit || 100, 100);
    const offset = (page - 1) * limit;
    const category = options?.category;

    const conditions = this.scopeConditions();
    if (category) {
      conditions.push(eq(products.categoryId, category));
    }

    const totalResult = await this.dbService.db
      .select({ count: count() })
      .from(products)
      .where(and(...conditions));
    const total = totalResult[0]?.count ?? 0;

    const list = await this.dbService.db
      .select(publicProductColumns)
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

  async findOne(id: string): Promise<StorePublicProduct> {
    const [product] = await this.dbService.db
      .select(publicProductColumns)
      .from(products)
      .where(and(eq(products.id, id), ...this.scopeConditions()))
      .limit(1);

    if (!product) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
    }
    return product;
  }

  /**
   * Pre-checkout guard: every ordered product must exist in the storefront's
   * scope (active + store business) and have enough stock on hand. The sale
   * itself still runs through order.service.create, which consumes batches;
   * this check just turns a silent oversell into a clear customer-facing error.
   */
  async assertOrderable(
    items: { productId: string; quantity: number }[],
  ): Promise<void> {
    const ids = items.map((i) => i.productId);
    const rows = await this.dbService.db
      .select({
        id: products.id,
        name: products.name,
        quantity: products.quantity,
      })
      .from(products)
      .where(and(inArray(products.id, ids), ...this.scopeConditions()));
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const item of items) {
      const product = byId.get(item.productId);
      if (!product) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
          productId: item.productId,
        });
      }
      if (product.quantity < item.quantity) {
        throw new AppException(ErrorCode.STORE_INSUFFICIENT_STOCK, {
          qty: item.quantity,
          name: product.name,
          available: product.quantity,
        });
      }
    }
  }
}
