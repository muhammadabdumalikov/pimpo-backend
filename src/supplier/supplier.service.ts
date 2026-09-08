import {Injectable, Inject} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {DatabaseService} from '../database/database.service';
import {
  suppliers,
  products,
  goodsReceipts,
  goodsReceiptItems,
  type Supplier,
  type NewSupplier,
} from '../database/schema';
import {
  eq,
  and,
  asc,
  desc,
  ilike,
  or,
  ne,
  isNotNull,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {CacheKeys, TTL} from '../cache/cache.util';

@Injectable()
export class SupplierService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async create(
    businessId: string,
    data: {name: string; phone?: string; note?: string},
  ): Promise<Supplier> {
    const newSupplier: NewSupplier = {
      id: generateId(),
      businessId,
      name: data.name,
      phone: data.phone || null,
      note: data.note || null,
      isActive: true,
    };

    const [supplier] = await this.dbService.db
      .insert(suppliers)
      .values(newSupplier)
      .returning();

    await this.cache.del(CacheKeys.suppliers(businessId));

    return supplier;
  }

  async findAll(
    businessId: string,
    options?: {page?: number; limit?: number; search?: string},
  ): Promise<{
    suppliers: Supplier[];
    total: number;
    page: number;
    limit: number;
  }> {
    const isPlainList = !options?.page && !options?.limit && !options?.search;

    if (isPlainList) {
      return this.cache.wrap(
        CacheKeys.suppliers(businessId),
        () => this.findAllUncached(businessId, options),
        TTL.SUPPLIERS,
      );
    }

    return this.findAllUncached(businessId, options);
  }

  private async findAllUncached(
    businessId: string,
    options?: {page?: number; limit?: number; search?: string},
  ): Promise<{
    suppliers: Supplier[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;
    const search = options?.search;

    const whereConditions = [
      eq(suppliers.businessId, businessId),
      eq(suppliers.isActive, true),
    ];

    if (search) {
      whereConditions.push(
        or(
          ilike(suppliers.name, `%${search}%`),
          ilike(suppliers.phone, `%${search}%`),
        )!,
      );
    }

    const all = await this.dbService.db
      .select()
      .from(suppliers)
      .where(and(...whereConditions));
    const total = all.length;

    const paginated = await this.dbService.db
      .select()
      .from(suppliers)
      .where(and(...whereConditions))
      .orderBy(desc(suppliers.createdAt))
      .limit(limit)
      .offset(offset);

    return {suppliers: paginated, total, page, limit};
  }

  /**
   * What a business buys from one supplier.
   *
   * Two things make a product theirs: it is *assigned* to them (the product's
   * own default supplier) or it has actually *arrived* from them on a received
   * order. The page shows both, because either one alone lies — a product
   * bought from them for years may never have been assigned, and a freshly
   * assigned one has no deliveries yet.
   *
   * Every purchase figure is drawn from received orders only (a draft has not
   * happened yet) and in base UZS (`priceInBase`), so a supplier billing in USD
   * doesn't add dollars to so'm.
   */
  async findProducts(
    businessId: string,
    supplierId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
      stock?: 'in' | 'low' | 'out';
      categoryId?: string;
      /** Which link counts: assigned to them, received from them, or either. */
      source?: 'all' | 'assigned' | 'received';
      sort?: 'recent' | 'name' | 'quantity' | 'spend';
    },
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const offset = (page - 1) * limit;
    const source = options?.source ?? 'all';
    const sort = options?.sort ?? 'recent';

    // Unit cost in base UZS. The line keeps the price in the order's own
    // currency, so a USD order is converted with the rate it was booked at —
    // otherwise dollars and so'm would be summed together.
    const baseCost = sql`(${goodsReceiptItems.priceIn} * (case when ${goodsReceipts.currency} = 'USD' then coalesce(${goodsReceipts.usdRate}, 1) else 1 end))`;

    // Per product: what this supplier actually delivered.
    const supplied = this.dbService.db
      .select({
        productId: goodsReceiptItems.productId,
        receivedQty: sql<number>`sum(${goodsReceiptItems.quantity})::float8`.as(
          'received_qty',
        ),
        receiptCount: sql<number>`count(distinct ${goodsReceipts.id})::int`.as(
          'receipt_count',
        ),
        lastReceivedAt: sql<string>`max(${goodsReceipts.createdAt})`.as(
          'last_received_at',
        ),
        // The cost on the most recent delivery: array_agg keeps the whole
        // ordered set and takes its head, which one GROUP BY can do without a
        // window or a lateral join.
        lastPriceIn:
          sql<string>`(array_agg(${baseCost} order by ${goodsReceipts.createdAt} desc))[1]`.as(
            'last_price_in',
          ),
        totalSpend:
          sql<number>`sum(${baseCost} * ${goodsReceiptItems.quantity}::numeric)::float8`.as(
            'total_spend',
          ),
      })
      .from(goodsReceiptItems)
      .innerJoin(
        goodsReceipts,
        eq(goodsReceipts.id, goodsReceiptItems.receiptId),
      )
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          eq(goodsReceipts.supplierId, supplierId),
          ne(goodsReceipts.status, 'draft'),
        ),
      )
      .groupBy(goodsReceiptItems.productId)
      .as('supplied');

    const whereConditions = [
      eq(products.businessId, businessId),
      eq(products.isActive, true),
    ];

    if (source === 'assigned') {
      whereConditions.push(eq(products.supplierId, supplierId));
    } else if (source === 'received') {
      whereConditions.push(isNotNull(supplied.productId));
    } else {
      whereConditions.push(
        or(eq(products.supplierId, supplierId), isNotNull(supplied.productId))!,
      );
    }

    if (options?.search) {
      whereConditions.push(
        or(
          ilike(products.name, `%${options.search}%`),
          ilike(products.code, `%${options.search}%`),
          ilike(products.barcode, `%${options.search}%`),
        )!,
      );
    }

    if (options?.categoryId) {
      whereConditions.push(eq(products.categoryId, options.categoryId));
    }

    if (options?.stock) {
      // Same buckets as the catalogue: a product is "low" at or below its own
      // reorder point, falling back to 10 when it has none.
      const threshold = sql`coalesce(${products.lowStockThreshold}, 10)`;
      whereConditions.push(
        options.stock === 'out'
          ? sql`${products.quantity} <= 0`
          : options.stock === 'low'
            ? sql`${products.quantity} > 0 and ${products.quantity} <= ${threshold}`
            : sql`${products.quantity} > ${threshold}`,
      );
    }

    const where = and(...whereConditions);

    const orderBy =
      sort === 'name'
        ? asc(products.name)
        : sort === 'quantity'
          ? desc(products.quantity)
          : sort === 'spend'
            ? sql`${supplied.totalSpend} desc nulls last`
            : sql`${supplied.lastReceivedAt} desc nulls last`;

    const [{value: total}] = await this.dbService.db
      .select({value: sql<number>`count(*)::int`})
      .from(products)
      .leftJoin(supplied, eq(supplied.productId, products.id))
      .where(where);

    const rows = await this.dbService.db
      .select({
        ...getTableColumns(products),
        receivedQty: supplied.receivedQty,
        receiptCount: supplied.receiptCount,
        lastReceivedAt: supplied.lastReceivedAt,
        lastPriceIn: supplied.lastPriceIn,
        totalSpend: supplied.totalSpend,
      })
      .from(products)
      .leftJoin(supplied, eq(supplied.productId, products.id))
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    // Header figures for the whole (filtered) list, not the visible page.
    // The stock buckets are the catalogue's own (same reorder-point rule), so
    // the panel here reads like the products page's.
    const onHand = sql`greatest(${products.quantity}, 0)::numeric`;
    const lowPoint = sql`coalesce(${products.lowStockThreshold}, 10)`;
    const [summary] = await this.dbService.db
      .select({
        products: sql<number>`count(*)::int`,
        totalSpend: sql<number>`coalesce(sum(${supplied.totalSpend}), 0)::float8`,
        lastReceivedAt: sql<string | null>`max(${supplied.lastReceivedAt})`,
        inStock: sql<number>`count(*) filter (where ${products.quantity} > ${lowPoint})::int`,
        lowStock: sql<number>`count(*) filter (where ${products.quantity} > 0 and ${products.quantity} <= coalesce(${products.lowStockThreshold}, 10))::int`,
        outOfStock: sql<number>`count(*) filter (where ${products.quantity} <= 0)::int`,
        units: sql<number>`coalesce(sum(${onHand}), 0)::float8`,
        // What the stock on hand is worth, at cost and at the shelf price.
        supplyValue: sql<number>`coalesce(sum(greatest(${products.quantity}, 0)::numeric * ${products.priceIn}), 0)::float8`,
        retailValue: sql<number>`coalesce(sum(greatest(${products.quantity}, 0)::numeric * ${products.priceOut}), 0)::float8`,
      })
      .from(products)
      .leftJoin(supplied, eq(supplied.productId, products.id))
      .where(where);

    const purchases = await this.purchaseHistory(businessId, supplierId);

    return {
      products: rows,
      total,
      page,
      limit,
      summary: summary ?? {
        products: 0,
        totalSpend: 0,
        lastReceivedAt: null,
        inStock: 0,
        lowStock: 0,
        outOfStock: 0,
        units: 0,
        supplyValue: 0,
        retailValue: 0,
      },
      purchases,
    };
  }

  /**
   * What has been bought from this supplier, month by month.
   *
   * Read off the orders themselves (not their lines): this is the trade with
   * the supplier, so it must not move when the product list above is filtered.
   * Drafts are excluded — they have not happened — and a USD order is counted
   * at the rate it was booked at.
   *
   * The window is the last 12 calendar months including this one; a month with
   * no delivery is absent from the result and is drawn as a gap by the caller.
   */
  private async purchaseHistory(businessId: string, supplierId: string) {
    const spend = sql`sum(${goodsReceipts.totalAmount} * (case when ${goodsReceipts.currency} = 'USD' then coalesce(${goodsReceipts.usdRate}, 1) else 1 end))::float8`;

    const rows = await this.dbService.db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${goodsReceipts.createdAt}), 'YYYY-MM')`,
        spend: spend.mapWith(Number),
        receipts: sql<number>`count(*)::int`,
      })
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          eq(goodsReceipts.supplierId, supplierId),
          ne(goodsReceipts.status, 'draft'),
          sql`${goodsReceipts.createdAt} >= date_trunc('month', now()) - interval '11 months'`,
        ),
      )
      // A second fragment rather than the one in the SELECT: a reused sql
      // object would send its parameters twice.
      .groupBy(sql`date_trunc('month', ${goodsReceipts.createdAt})`)
      .orderBy(sql`date_trunc('month', ${goodsReceipts.createdAt})`);

    const [totals] = await this.dbService.db
      .select({
        total: sql<number>`coalesce(sum(${goodsReceipts.totalAmount} * (case when ${goodsReceipts.currency} = 'USD' then coalesce(${goodsReceipts.usdRate}, 1) else 1 end)), 0)::float8`,
        receiptCount: sql<number>`count(*)::int`,
        // Still owed on their orders — a supplier page without it tells only
        // half of the relationship.
        unpaid: sql<number>`coalesce(sum(greatest((${goodsReceipts.totalAmount} - ${goodsReceipts.paidAmount} - ${goodsReceipts.returnedAmount}), 0) * (case when ${goodsReceipts.currency} = 'USD' then coalesce(${goodsReceipts.usdRate}, 1) else 1 end)), 0)::float8`,
      })
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          eq(goodsReceipts.supplierId, supplierId),
          ne(goodsReceipts.status, 'draft'),
        ),
      );

    return {
      total: totals?.total ?? 0,
      receiptCount: totals?.receiptCount ?? 0,
      unpaid: totals?.unpaid ?? 0,
      monthly: rows,
    };
  }

  async findOne(
    businessId: string,
    supplierId: string,
  ): Promise<Supplier | null> {
    const [supplier] = await this.dbService.db
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, supplierId),
          eq(suppliers.businessId, businessId),
          eq(suppliers.isActive, true),
        ),
      )
      .limit(1);

    return supplier || null;
  }

  async update(
    businessId: string,
    supplierId: string,
    data: Partial<Omit<NewSupplier, 'id' | 'businessId' | 'createdAt'>>,
  ): Promise<Supplier> {
    const existing = await this.findOne(businessId, supplierId);
    if (!existing) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
    }

    const [supplier] = await this.dbService.db
      .update(suppliers)
      .set({...data, updatedAt: new Date()})
      .where(
        and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)),
      )
      .returning();

    await this.cache.del(CacheKeys.suppliers(businessId));

    return supplier;
  }

  async remove(businessId: string, supplierId: string): Promise<void> {
    const existing = await this.findOne(businessId, supplierId);
    if (!existing) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
    }

    // Soft delete (receipts keep their supplierName snapshot).
    await this.dbService.db
      .update(suppliers)
      .set({isActive: false, updatedAt: new Date()})
      .where(
        and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)),
      );

    await this.cache.del(CacheKeys.suppliers(businessId));
  }
}
