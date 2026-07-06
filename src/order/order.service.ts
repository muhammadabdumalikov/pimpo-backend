import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and, desc, ilike, or, count, sql, gte, lte } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  orders,
  orderItems,
  products,
  categories,
  users,
  userDebts,
  receiptSettings,
  staff,
  businesses,
  type Order,
  type OrderItem,
} from '../database/schema';
import { generateId } from '../utils/uuid';
import { UserService } from '../user/user.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { IAccount } from '../business/types';
import { consumeBatches, type CostingMethod } from './costing';

export type OrderWithItems = Order & { items: OrderItem[] };

function money(value: number): string {
  return value.toFixed(2);
}

@Injectable()
export class OrderService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly userService: UserService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  // Resolve the acting account into a snapshotted cashier (id + display name).
  private async resolveCashier(
    account?: IAccount,
  ): Promise<{ id: string | null; name: string | null }> {
    if (!account) return { id: null, name: null };
    if (account.type === 'staff') {
      const [row] = await this.dbService.db
        .select({ name: staff.name })
        .from(staff)
        .where(eq(staff.id, account.id))
        .limit(1);
      return { id: account.id, name: row?.name ?? null };
    }
    const [row] = await this.dbService.db
      .select({ name: businesses.name })
      .from(businesses)
      .where(eq(businesses.id, account.id))
      .limit(1);
    return { id: account.id, name: row?.name ?? null };
  }

  async create(
    businessId: string,
    dto: CreateOrderDto,
    account?: IAccount,
  ): Promise<OrderWithItems> {
    const isDebt = dto.paymentMethod === 'debt';
    const cashier = await this.resolveCashier(account);

    // Resolve optional customer.
    let customerName = dto.customerName ?? null;
    let customerId: string | null = dto.userId ?? null;
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

    // A debt sale ("give on credit") must be tied to a real customer so we can
    // track who owes what, for which order. The due date is optional.
    if (isDebt) {
      // Respect the plan's debt limit (same rule as the standalone debt page).
      const { debtsLimit } =
        await this.subscriptionService.getSubscriptionLimits(businessId);
      if (debtsLimit !== null) {
        const [{ value: debtCount }] = await this.dbService.db
          .select({ value: count() })
          .from(userDebts)
          .where(eq(userDebts.businessId, businessId));
        if (debtCount >= debtsLimit) {
          throw new ForbiddenException(
            `Debt limit of ${debtsLimit} reached for your current plan.`,
          );
        }
      }
      // Resolve the customer: existing id, or find-or-create by name + phone.
      if (!customerId) {
        if (!customerName || !dto.phone) {
          throw new BadRequestException(
            'A customer name and phone are required for a debt sale',
          );
        }
        const existing = await this.userService.findByPhone(businessId, dto.phone);
        const user =
          existing ??
          (await this.userService.create(businessId, {
            name: customerName,
            phone: dto.phone,
          }));
        customerId = user.id;
        if (!customerName) customerName = user.name;
      }
    }

    // Validate + snapshot each product. Cost and revenue are valued from the
    // inventory batches inside the transaction below (selling price is per
    // batch), so here we only capture each product's id/name and its current
    // priceIn/priceOut to use as the oversell fallback.
    const planned: {
      productId: string;
      productName: string;
      priceIn: number;
      priceOut: number;
      quantity: number;
    }[] = [];
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
      planned.push({
        productId: product.id,
        productName: product.name,
        priceIn: Number(product.priceIn),
        priceOut: Number(product.priceOut),
        quantity: item.quantity,
      });
      itemCount += item.quantity;
    }

    // VAT (QQS, inclusive) + costing method come from the business settings.
    const [settings] = await this.dbService.db
      .select({
        vatEnabled: receiptSettings.vatEnabled,
        vatRate: receiptSettings.vatRate,
        costingMethod: receiptSettings.costingMethod,
      })
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);
    const vatEnabled = settings?.vatEnabled ?? false;
    const vatRate = vatEnabled ? Number(settings?.vatRate ?? 0) : 0;
    const method: CostingMethod =
      settings?.costingMethod === 'FIFO' ? 'FIFO' : 'AVERAGE';

    const orderId = generateId();

    await this.dbService.db.transaction(async (tx) => {
      // Value each line against the FIFO batch queue (locks batches FOR UPDATE),
      // producing the COGS + batch-priced revenue snapshot. `total` is the sum of
      // the real per-batch revenue, so it must be computed here, before payments.
      const lines: {
        productId: string;
        productName: string;
        priceOut: string;
        quantity: number;
        lineTotal: string;
        costIn: string;
        costTotal: string;
        frontPriceOut: string | null;
      }[] = [];
      let total = 0;

      for (const p of planned) {
        const c = await consumeBatches(
          tx,
          businessId,
          p.productId,
          p.quantity,
          method,
          p.priceIn,
          p.priceOut,
        );
        total += c.revenueTotal;
        lines.push({
          productId: p.productId,
          productName: p.productName,
          priceOut: money(c.priceOut),
          quantity: p.quantity,
          lineTotal: money(c.revenueTotal),
          costIn: money(c.costIn),
          costTotal: money(c.costTotal),
          frontPriceOut: c.frontPriceOut,
        });
      }

      // Apply the manual whole-receipt discount (fixed soʻm or percent) to the
      // gross subtotal. COGS is untouched, so profit = discounted revenue - cost.
      // Everything below (payments, VAT, debt, totalAmount) keys off the net total.
      const subtotal = total;
      let discountType: string | null = null;
      let discountValue: number | null = null;
      let discountAmount = 0;
      if (dto.discountType && dto.discountValue && dto.discountValue > 0) {
        discountType = dto.discountType;
        discountValue = dto.discountValue;
        const raw =
          dto.discountType === 'percent'
            ? (subtotal * Math.min(dto.discountValue, 100)) / 100
            : dto.discountValue;
        discountAmount = Math.max(0, Math.min(raw, subtotal));
      }
      total = subtotal - discountAmount;

      // Resolve the payment breakdown against the batch-priced total.
      let payments: { method: string; amount: number }[];
      let paymentMethod: string | null;
      let amountPaid: number;
      let changeAmount: number;
      // For a debt sale this is the unpaid remainder owed by the customer.
      let debtAmount = 0;

      if (isDebt) {
        // `payments` here is what the customer pays *now* (a down payment); the
        // rest becomes the debt. An empty list means the whole total is owed.
        payments = (dto.payments ?? []).map((p) => ({
          method: p.method,
          amount: p.amount,
        }));
        const paidNow = payments.reduce((sum, p) => sum + p.amount, 0);
        debtAmount = Math.max(0, total - paidNow);
        paymentMethod = 'debt';
        const cashApplied = payments
          .filter((p) => p.method === 'cash')
          .reduce((sum, p) => sum + p.amount, 0);
        amountPaid = dto.amountPaid ?? cashApplied;
        changeAmount = 0;
      } else {
        // Default to a single method covering the whole total.
        payments =
          dto.payments && dto.payments.length > 0
            ? dto.payments.map((p) => ({ method: p.method, amount: p.amount }))
            : [{ method: dto.paymentMethod ?? 'cash', amount: total }];
        const methods = Array.from(new Set(payments.map((p) => p.method)));
        paymentMethod =
          methods.length > 1
            ? 'split'
            : (methods[0] ?? dto.paymentMethod ?? null);
        // Cash tendered (defaults to the total); change is over the cash portion.
        const cashApplied = payments
          .filter((p) => p.method === 'cash')
          .reduce((sum, p) => sum + p.amount, 0);
        amountPaid = dto.amountPaid ?? cashApplied;
        changeAmount = Math.max(0, amountPaid - cashApplied);
      }

      const taxAmount = vatRate > 0 ? (total * vatRate) / (100 + vatRate) : 0;

      await tx.insert(orders).values({
        id: orderId,
        businessId,
        userId: customerId,
        customerName,
        status: dto.status ?? 'Pending',
        totalAmount: money(total),
        subtotalAmount: money(subtotal),
        discountType,
        discountValue: discountValue !== null ? money(discountValue) : null,
        discountAmount: money(discountAmount),
        itemCount,
        paymentMethod,
        payments,
        amountPaid: money(amountPaid),
        changeAmount: money(changeAmount),
        taxRate: money(vatRate),
        taxAmount: money(taxAmount),
        note: dto.note ?? null,
        source: dto.source ?? 'admin',
        cashierId: cashier.id,
        cashierName: cashier.name,
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
          costIn: line.costIn,
          costTotal: line.costTotal,
        })),
      );

      // Decrement stock (never below zero) and keep the displayed selling price
      // tracking the new FIFO-front batch (the next unit to be sold).
      for (const line of lines) {
        await tx
          .update(products)
          .set({
            quantity: sql`GREATEST(0, ${products.quantity} - ${line.quantity})`,
            ...(line.frontPriceOut !== null
              ? { priceOut: line.frontPriceOut }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, line.productId),
            ),
          );
      }

      // Debt sale: record the unpaid remainder as a credit, linked to this
      // order + customer. (Skip if a down payment covered the whole total.)
      if (isDebt && customerId && debtAmount > 0) {
        const itemSummary = lines
          .map((l) => `${l.productName} ×${l.quantity}`)
          .join(', ');
        await tx.insert(userDebts).values({
          id: generateId(),
          businessId,
          userId: customerId,
          orderId,
          amount: money(debtAmount),
          status: 'Pending',
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          description: itemSummary.slice(0, 500),
        });
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
   * Per-product sales aggregation from completed orders. Units sold, revenue and
   * cost all come from the order_items snapshots (so deleted products still count
   * and COGS reflects the cost at sale time, not the current price). Pre-migration
   * rows have costTotal=0 and fall back to the product's current `priceIn`.
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
        // COGS from the per-sale snapshot (accurate after price changes). Falls
        // back to current priceIn for pre-migration rows where costTotal is 0.
        cost: sql<string>`COALESCE(SUM(
          CASE WHEN ${orderItems.costTotal} > 0
            THEN ${orderItems.costTotal}
            ELSE ${orderItems.quantity} * COALESCE(${products.priceIn}, 0)
          END
        ), 0)`,
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

  /**
   * Completed-order revenue grouped by calendar month for a given year.
   * Returns exactly 12 numbers (Jan..Dec); months with no sales are 0.
   */
  async getMonthlySales(businessId: string, year: number): Promise<number[]> {
    const rows = await this.dbService.db
      .select({
        month: sql<number>`EXTRACT(MONTH FROM ${orders.createdAt})`,
        sum: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          sql`EXTRACT(YEAR FROM ${orders.createdAt}) = ${year}`,
        ),
      )
      .groupBy(sql`EXTRACT(MONTH FROM ${orders.createdAt})`);

    const monthly = new Array<number>(12).fill(0);
    for (const r of rows) {
      const m = Number(r.month);
      if (m >= 1 && m <= 12) monthly[m - 1] = Number(r.sum);
    }
    return monthly;
  }

  /**
   * Completed-order sales grouped by the cashier (acting account) who rang them
   * up. `cashierId === null` covers storefront/guest and pre-migration orders.
   */
  async getSalesByEmployee(
    businessId: string,
    options: { from?: string; to?: string } = {},
  ): Promise<
    Array<{
      cashierId: string | null;
      cashierName: string | null;
      orderCount: number;
      revenue: number;
    }>
  > {
    const where = [
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
    ];
    if (options.from) {
      where.push(gte(orders.createdAt, new Date(options.from)));
    }
    if (options.to) {
      const to = new Date(options.to);
      to.setHours(23, 59, 59, 999);
      where.push(lte(orders.createdAt, to));
    }

    const rows = await this.dbService.db
      .select({
        cashierId: orders.cashierId,
        cashierName: sql<string | null>`MAX(${orders.cashierName})`,
        orderCount: count(),
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(and(...where))
      .groupBy(orders.cashierId)
      .orderBy(desc(sql`COALESCE(SUM(${orders.totalAmount}), 0)`));

    return rows.map((r) => ({
      cashierId: r.cashierId,
      cashierName: r.cashierName ?? null,
      orderCount: Number(r.orderCount),
      revenue: Number(r.revenue),
    }));
  }
}
