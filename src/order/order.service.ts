import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, ilike, or, count, sql, gte, lte } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  orders,
  orderItems,
  products,
  categories,
  users,
  receiptSettings,
  type Order,
  type OrderItem,
} from '../database/schema';
import { generateId } from '../utils/uuid';
import { CreateOrderDto } from './dto/create-order.dto';

export type OrderWithItems = Order & { items: OrderItem[] };

function money(value: number): string {
  return value.toFixed(2);
}

@Injectable()
export class OrderService {
  constructor(private readonly dbService: DatabaseService) {}

  async create(businessId: string, dto: CreateOrderDto): Promise<OrderWithItems> {
    // Resolve optional customer.
    let customerName = dto.customerName ?? null;
    if (dto.userId) {
      const [user] = await this.dbService.db
        .select()
        .from(users)
        .where(and(eq(users.businessId, businessId), eq(users.id, dto.userId)))
        .limit(1);
      if (!user) {
        throw new BadRequestException('Customer not found for this business');
      }
      if (!customerName) customerName = user.name;
    }

    // Load + snapshot each product, compute totals.
    const lines: {
      productId: string;
      productName: string;
      priceOut: string;
      quantity: number;
      lineTotal: string;
    }[] = [];
    let total = 0;
    let itemCount = 0;

    for (const item of dto.items) {
      const [product] = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(eq(products.businessId, businessId), eq(products.id, item.productId)),
        )
        .limit(1);
      if (!product) {
        throw new BadRequestException(`Product not found: ${item.productId}`);
      }
      const lineTotal = Number(product.priceOut) * item.quantity;
      total += lineTotal;
      itemCount += item.quantity;
      lines.push({
        productId: product.id,
        productName: product.name,
        priceOut: product.priceOut,
        quantity: item.quantity,
        lineTotal: money(lineTotal),
      });
    }

    const orderId = generateId();

    // Resolve the payment breakdown. Default to a single method covering the
    // whole total when no explicit split is provided.
    const payments =
      dto.payments && dto.payments.length > 0
        ? dto.payments.map((p) => ({ method: p.method, amount: p.amount }))
        : [{ method: dto.paymentMethod ?? 'cash', amount: total }];
    const methods = Array.from(new Set(payments.map((p) => p.method)));
    const paymentMethod =
      methods.length > 1 ? 'split' : (methods[0] ?? dto.paymentMethod ?? null);
    // Cash tendered (defaults to the total when not provided); change is what we
    // hand back over the cash portion.
    const cashApplied = payments
      .filter((p) => p.method === 'cash')
      .reduce((sum, p) => sum + p.amount, 0);
    const amountPaid = dto.amountPaid ?? cashApplied;
    const changeAmount = Math.max(0, amountPaid - cashApplied);

    // VAT (QQS) is inclusive: break out the tax portion of the total without
    // changing it. Rate comes from the business's settings.
    const [settings] = await this.dbService.db
      .select({
        vatEnabled: receiptSettings.vatEnabled,
        vatRate: receiptSettings.vatRate,
      })
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);
    const vatEnabled = settings?.vatEnabled ?? false;
    const vatRate = vatEnabled ? Number(settings?.vatRate ?? 0) : 0;
    const taxAmount =
      vatRate > 0 ? (total * vatRate) / (100 + vatRate) : 0;

    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(orders).values({
        id: orderId,
        businessId,
        userId: dto.userId ?? null,
        customerName,
        status: dto.status ?? 'Pending',
        totalAmount: money(total),
        itemCount,
        paymentMethod,
        payments,
        amountPaid: money(amountPaid),
        changeAmount: money(changeAmount),
        taxRate: money(vatRate),
        taxAmount: money(taxAmount),
        note: dto.note ?? null,
        source: dto.source ?? 'admin',
      });

      await tx.insert(orderItems).values(
        lines.map((line) => ({
          id: generateId(),
          orderId,
          businessId,
          productId: line.productId,
          productName: line.productName,
          priceOut: line.priceOut,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
        })),
      );

      // Decrement stock, never below zero.
      for (const line of lines) {
        await tx
          .update(products)
          .set({
            quantity: sql`GREATEST(0, ${products.quantity} - ${line.quantity})`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, line.productId),
            ),
          );
      }
    });

    return this.findOne(businessId, orderId) as Promise<OrderWithItems>;
  }

  /**
   * Public storefront checkout: there is no authenticated business, so the
   * owning business is derived from the first product, and all items must
   * belong to it (enforced by create()'s per-product business check).
   */
  async createStore(dto: CreateOrderDto): Promise<OrderWithItems> {
    const firstId = dto.items[0]?.productId;
    if (!firstId) {
      throw new BadRequestException('Order must contain at least one item');
    }
    const [product] = await this.dbService.db
      .select({ businessId: products.businessId })
      .from(products)
      .where(eq(products.id, firstId))
      .limit(1);
    if (!product) {
      throw new BadRequestException(`Product not found: ${firstId}`);
    }
    return this.create(product.businessId, {
      ...dto,
      userId: undefined,
      status: 'Pending',
      source: 'store',
    });
  }

  async findAll(
    businessId: string,
    options?: { page?: number; limit?: number; search?: string; status?: string },
  ): Promise<{ orders: Order[]; total: number; page: number; limit: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;

    const where = [eq(orders.businessId, businessId)];
    if (options?.status) {
      where.push(eq(orders.status, options.status));
    }
    if (options?.search) {
      where.push(
        or(
          ilike(orders.customerName, `%${options.search}%`),
          ilike(orders.id, `%${options.search}%`),
        )!,
      );
    }

    const totalResult = await this.dbService.db
      .select({ count: count() })
      .from(orders)
      .where(and(...where));

    const rows = await this.dbService.db
      .select()
      .from(orders)
      .where(and(...where))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);

    return { orders: rows, total: totalResult[0].count, page, limit };
  }

  async findOne(businessId: string, id: string): Promise<OrderWithItems | null> {
    const [order] = await this.dbService.db
      .select()
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)))
      .limit(1);
    if (!order) return null;

    const items = await this.dbService.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    return { ...order, items };
  }

  async findByUser(businessId: string, userId: string): Promise<Order[]> {
    return this.dbService.db
      .select()
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.userId, userId)))
      .orderBy(desc(orders.createdAt));
  }

  async updateStatus(
    businessId: string,
    id: string,
    status: string,
  ): Promise<OrderWithItems> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new NotFoundException('Order not found');
    }
    await this.dbService.db
      .update(orders)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)));
    return this.findOne(businessId, id) as Promise<OrderWithItems>;
  }

  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new NotFoundException('Order not found');
    }
    await this.dbService.db
      .delete(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)));
  }

  async getCount(businessId: string): Promise<number> {
    const result = await this.dbService.db
      .select({ count: count() })
      .from(orders)
      .where(eq(orders.businessId, businessId));
    return result[0].count;
  }

  /**
   * Per-product sales aggregation from completed orders. Units sold and revenue
   * come from the order_items snapshots (so deleted products still count); cost
   * and profit use the product's current `priceIn` (0 when the product is gone).
   * Optional inclusive date range filters on the order's creation date.
   */
  async getProductPerformance(
    businessId: string,
    options?: { from?: string; to?: string },
  ): Promise<
    {
      productId: string | null;
      name: string;
      code: string | null;
      image: string | null;
      category: string | null;
      unitsSold: number;
      revenue: number;
      profit: number;
      profitMargin: number;
    }[]
  > {
    const where = [
      eq(orderItems.businessId, businessId),
      eq(orders.status, 'Completed'),
    ];
    if (options?.from) {
      where.push(gte(orders.createdAt, new Date(options.from)));
    }
    if (options?.to) {
      // Include the whole "to" day by pushing to end-of-day.
      const to = new Date(options.to);
      to.setHours(23, 59, 59, 999);
      where.push(lte(orders.createdAt, to));
    }

    const rows = await this.dbService.db
      .select({
        productId: orderItems.productId,
        name: sql<string>`MAX(${orderItems.productName})`,
        code: sql<string | null>`MAX(${products.code})`,
        image: sql<string | null>`MAX(${products.image})`,
        category: sql<string | null>`MAX(${categories.name})`,
        unitsSold: sql<string>`COALESCE(SUM(${orderItems.quantity}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${orderItems.lineTotal}), 0)`,
        cost: sql<string>`COALESCE(SUM(${orderItems.quantity} * COALESCE(${products.priceIn}, 0)), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .leftJoin(products, eq(orderItems.productId, products.id))
      .leftJoin(
        categories,
        and(
          eq(products.categoryId, categories.id),
          eq(categories.businessId, businessId),
        ),
      )
      .where(and(...where))
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`SUM(${orderItems.lineTotal})`));

    return rows.map((r) => {
      const revenue = Number(r.revenue);
      const profit = revenue - Number(r.cost);
      return {
        productId: r.productId,
        name: r.name,
        code: r.code,
        image: r.image,
        category: r.category,
        unitsSold: Number(r.unitsSold),
        revenue,
        profit,
        profitMargin: revenue > 0 ? (profit / revenue) * 100 : 0,
      };
    });
  }

  async getRevenue(businessId: string): Promise<number> {
    const [row] = await this.dbService.db
      .select({
        sum: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(eq(orders.businessId, businessId), eq(orders.status, 'Completed')),
      );
    return Number(row?.sum ?? 0);
  }
}
