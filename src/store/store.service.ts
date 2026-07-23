import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import { products, orders, orderItems, businesses } from '../database/schema';
import { eq, and, desc, count, inArray, ilike, sql } from 'drizzle-orm';

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

  /**
   * Resolve the storefront's business from the request's subdomain slug.
   * - A slug (e.g. "salom" from salom.kpos.uz) must map to an enabled, active
   *   store, else STORE_NOT_FOUND.
   * - No slug (apex domain / local dev) falls back to the STORE_BUSINESS_ID env,
   *   or null (unscoped) when that is unset too.
   * The resolved businessId is threaded into every query below so one tenant's
   * storefront can never read or order another's catalog.
   */
  async resolveBusinessId(slug?: string | null): Promise<string | null> {
    const trimmed = slug?.trim().toLowerCase();
    if (trimmed) {
      const [biz] = await this.dbService.db
        .select({ id: businesses.id })
        .from(businesses)
        .where(
          and(
            eq(businesses.storeSlug, trimmed),
            eq(businesses.storeEnabled, true),
            eq(businesses.isActive, true),
          ),
        )
        .limit(1);
      if (!biz) {
        throw new AppException(ErrorCode.STORE_NOT_FOUND);
      }
      return biz.id;
    }
    return process.env.STORE_BUSINESS_ID || null;
  }

  /** Public storefront branding for the resolved business (name shown in the
   *  header/footer). Null businessId (apex, unscoped) returns a neutral name. */
  async getInfo(
    businessId: string | null,
  ): Promise<{ name: string | null; slug: string | null }> {
    if (!businessId) return { name: null, slug: null };
    const [biz] = await this.dbService.db
      .select({ name: businesses.name, slug: businesses.storeSlug })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return { name: biz?.name ?? null, slug: biz?.slug ?? null };
  }

  private scopeConditions(businessId: string | null) {
    const conditions = [eq(products.isActive, true)];
    if (businessId) {
      conditions.push(eq(products.businessId, businessId));
    }
    return conditions;
  }

  async findAll(
    businessId: string | null,
    options?: {
      category?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{
    products: StorePublicProduct[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = options?.page || 1;
    const limit = Math.min(options?.limit || 100, 100);
    const offset = (page - 1) * limit;
    const category = options?.category;
    const search = options?.search?.trim();

    const conditions = this.scopeConditions(businessId);
    if (category) {
      conditions.push(eq(products.categoryId, category));
    }
    if (search) {
      conditions.push(ilike(products.name, `%${search}%`));
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
      // In-stock products first (search and category listings alike), newest
      // within each group.
      .orderBy(sql`(${products.quantity} > 0) DESC`, desc(products.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      products: list,
      total,
      page,
      limit,
    };
  }

  async findOne(
    businessId: string | null,
    id: string,
  ): Promise<StorePublicProduct> {
    const [product] = await this.dbService.db
      .select(publicProductColumns)
      .from(products)
      .where(and(eq(products.id, id), ...this.scopeConditions(businessId)))
      .limit(1);

    if (!product) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
    }
    return product;
  }

  /**
   * Public order-status lookup for the storefront customer. The order id (an
   * unguessable UUID handed out at checkout) is the access token; only
   * storefront orders are visible, and only safe fields are returned.
   */
  async findOrder(
    businessId: string | null,
    id: string,
  ): Promise<{
    id: string;
    status: string;
    totalAmount: string;
    itemCount: number;
    createdAt: Date;
    items: { productName: string; quantity: number; lineTotal: string }[];
  }> {
    const [order] = await this.dbService.db
      .select({
        id: orders.id,
        status: orders.status,
        totalAmount: orders.totalAmount,
        itemCount: orders.itemCount,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.id, id),
          eq(orders.source, 'store'),
          ...(businessId ? [eq(orders.businessId, businessId)] : []),
        ),
      )
      .limit(1);
    if (!order) {
      throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    }

    const items = await this.dbService.db
      .select({
        productName: orderItems.productName,
        quantity: orderItems.quantity,
        lineTotal: orderItems.lineTotal,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    return { ...order, items };
  }

  /**
   * Pre-checkout guard: every ordered product must exist in the storefront's
   * scope (active + store business) and have enough stock on hand. The sale
   * itself still runs through order.service.create, which consumes batches;
   * this check just turns a silent oversell into a clear customer-facing error.
   */
  async assertOrderable(
    businessId: string | null,
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
      .where(and(inArray(products.id, ids), ...this.scopeConditions(businessId)));
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
