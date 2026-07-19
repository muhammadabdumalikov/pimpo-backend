import {Injectable} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {
  orders,
  orderItems,
  products,
  categories,
  users,
  financialTransactions,
  cashShifts,
  inventoryBatches,
  goodsReceipts,
  goodsReceiptItems,
  supplierReturns,
  supplierReturnItems,
  stockTakes,
  stockTakeItems,
} from '../database/schema';
import {eq, and, gte, lte, gt, sql, desc} from 'drizzle-orm';

export interface DateRange {
  from?: string;
  to?: string;
  /** Optional branch ("do'kon") filter; omitted = all stores. */
  branchId?: string;
}

/**
 * Reports (Hisobotlar) — read-only analytics computed over existing sales,
 * finance, kassa and inventory data. Nothing here mutates state.
 *
 * Amounts are UZS (the base currency). Multi-currency (UZS/USD) reporting is a
 * later enhancement — see HISOBOTLAR.md R8.
 */
@Injectable()
export class ReportService {
  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  /** Inclusive [from, to] on a typed timestamp column; `to` is end-of-day. */
  private dateWhere(column: any, range?: DateRange) {
    const clauses: any[] = [];
    if (range?.from) clauses.push(gte(column, new Date(range.from)));
    if (range?.to) {
      const to = new Date(range.to);
      to.setHours(23, 59, 59, 999);
      clauses.push(lte(column, to));
    }
    return clauses;
  }

  /**
   * Inclusive [from, to] on a RAW sql expression (e.g. a COALESCE of two
   * columns). Unlike a typed column, drizzle can't infer the type here, so a JS
   * Date can't be bound safely — compare against string literals instead and let
   * Postgres cast them to timestamp.
   */
  private rawDateWhere(expr: any, range?: DateRange) {
    const clauses: any[] = [];
    if (range?.from) clauses.push(sql`${expr} >= ${range.from}`);
    if (range?.to) clauses.push(sql`${expr} <= ${`${range.to} 23:59:59.999`}`);
    return clauses;
  }

  /** Optional branch filter on a branch_id column. */
  private branchWhere(column: any, range?: DateRange) {
    return range?.branchId ? [eq(column, range.branchId)] : [];
  }

  // ─── R1: Foyda va zararlar (P&L) ──────────────────────────────────────────
  /**
   * Profit & Loss for a date range. Mirrors the BiLLZ P&L layout:
   *   Tushum → Chegirmalar → Sof tushum → COGS → Marjinal foyda →
   *   Xarajatlar (finance expense categories) → Kassa farqi → Sof foyda.
   *
   * - Revenue/discounts/COGS come from completed orders in the range.
   * - Expenses come from the finance ledger (kind='expense') grouped by category.
   * - "Kassa yopishdagi farq" is the sum of shift reconciliation differences for
   *   shifts closed in the range (surplus = income, shortage = expense).
   */
  async getPnl(businessId: string, range?: DateRange) {
    const orderWhere = and(
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
      ...this.dateWhere(orders.createdAt, range),
      ...this.branchWhere(orders.branchId, range),
    );

    // Gross (subtotal), whole-receipt discounts, net (total).
    const [rev] = await this.db
      .select({
        gross: sql<string>`COALESCE(SUM(${orders.subtotalAmount}), 0)`,
        discounts: sql<string>`COALESCE(SUM(${orders.discountAmount}), 0)`,
        net: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        orderCount: sql<string>`COUNT(*)`,
      })
      .from(orders)
      .where(orderWhere);

    // COGS from per-sale snapshots (falls back to current priceIn for pre-migration rows).
    const [cogsRow] = await this.db
      .select({
        cogs: sql<string>`COALESCE(SUM(
          CASE WHEN ${orderItems.costTotal} > 0
            THEN ${orderItems.costTotal}
            ELSE ${orderItems.quantity} * COALESCE(${products.priceIn}, 0)
          END
        ), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(orderWhere);

    // Expenses grouped by finance category (the ledger is the source of truth).
    const expenseRows = await this.db
      .select({
        category: sql<string>`COALESCE(${financialTransactions.categoryName}, 'Boshqa')`,
        amount: sql<string>`COALESCE(SUM(${financialTransactions.amount}), 0)`,
      })
      .from(financialTransactions)
      .where(
        and(
          eq(financialTransactions.businessId, businessId),
          eq(financialTransactions.kind, 'expense'),
          eq(financialTransactions.currency, 'UZS'),
          ...this.rawDateWhere(
            sql`COALESCE(${financialTransactions.operationDate}, ${financialTransactions.createdAt})`,
            range,
          ),
        ),
      )
      .groupBy(sql`COALESCE(${financialTransactions.categoryName}, 'Boshqa')`)
      .orderBy(desc(sql`SUM(${financialTransactions.amount})`));

    // Kassa reconciliation difference for shifts closed in the range.
    const [diffRow] = await this.db
      .select({
        difference: sql<string>`COALESCE(SUM(${cashShifts.difference}), 0)`,
      })
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.businessId, businessId),
          eq(cashShifts.status, 'closed'),
          ...this.dateWhere(cashShifts.closedAt, range),
        ),
      );

    const gross = Number(rev?.gross ?? 0);
    const discounts = Number(rev?.discounts ?? 0);
    const returns = 0; // Sales-return module not built yet (HISOBOTLAR.md R7).
    const net = Number(rev?.net ?? 0);
    const cogs = Number(cogsRow?.cogs ?? 0);
    const grossProfit = net - cogs;
    const grossMargin = net > 0 ? (grossProfit / net) * 100 : 0;
    const expenses = expenseRows.map((e) => ({
      category: e.category,
      amount: Number(e.amount),
    }));
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const cashDifference = Number(diffRow?.difference ?? 0);
    const netProfit = grossProfit - totalExpenses + cashDifference;

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      orderCount: Number(rev?.orderCount ?? 0),
      revenue: {gross, discounts, returns, net},
      totalIncome: net,
      cogs,
      grossProfit,
      grossMargin,
      expenses,
      totalExpenses,
      cashDifference,
      netProfit,
    };
  }

  // ─── R2: Qoldiqlar bo'yicha hisobot ───────────────────────────────────────
  /**
   * Stock valuation as of a date. Current stock is valued from open batches
   * (accurate weighted cost). When `date` is in the past, the quantity is rolled
   * back by replaying movements after that date (sales add back, receipts remove,
   * supplier-returns add back, stock-take adjustments remove). Cost is valued at
   * the current weighted-average priceIn (historical cost reconstruction is out
   * of scope for the MVP — noted in HISOBOTLAR.md).
   */
  async getStock(businessId: string, date?: string) {
    // Current per-product stock, cost (SUM batch qtyRemaining*priceIn) and sale value.
    const rows = await this.db
      .select({
        productId: products.id,
        name: products.name,
        code: products.code,
        image: products.image,
        category: sql<string | null>`MAX(${categories.name})`,
        quantity: products.quantity,
        priceIn: products.priceIn,
        priceOut: products.priceOut,
        batchCost: sql<string>`COALESCE(SUM(${inventoryBatches.qtyRemaining} * ${inventoryBatches.priceIn}), 0)`,
      })
      .from(products)
      .leftJoin(
        inventoryBatches,
        and(
          eq(inventoryBatches.productId, products.id),
          eq(inventoryBatches.businessId, businessId),
        ),
      )
      .leftJoin(
        categories,
        and(
          eq(products.categoryId, categories.id),
          eq(categories.businessId, businessId),
        ),
      )
      .where(and(eq(products.businessId, businessId), eq(products.isActive, true)))
      .groupBy(products.id)
      .orderBy(products.name);

    // Roll-back deltas after `date` (per product), if a past date is requested.
    const asOf = date ? new Date(date) : null;
    if (asOf) asOf.setHours(23, 59, 59, 999);
    const rollback = asOf ? await this.stockRollbackAfter(businessId, asOf) : new Map();

    const items = rows.map((r) => {
      const currentQty = r.quantity;
      const qty = asOf ? currentQty + (rollback.get(r.productId) ?? 0) : currentQty;
      const priceIn = Number(r.priceIn);
      const priceOut = Number(r.priceOut);
      // Prefer accurate batch cost for the current snapshot; fall back to
      // weighted-average priceIn (also used for past-date reconstruction).
      const costValue = asOf
        ? qty * priceIn
        : Number(r.batchCost) || currentQty * priceIn;
      const saleValue = qty * priceOut;
      return {
        productId: r.productId,
        name: r.name,
        code: r.code,
        image: r.image,
        category: r.category,
        quantity: qty,
        priceIn,
        priceOut,
        costValue,
        saleValue,
      };
    });

    const filtered = items.filter((i) => i.quantity !== 0);
    return {
      date: date ?? null,
      items: filtered,
      totals: {
        products: filtered.length,
        units: filtered.reduce((s, i) => s + i.quantity, 0),
        costValue: filtered.reduce((s, i) => s + i.costValue, 0),
        saleValue: filtered.reduce((s, i) => s + i.saleValue, 0),
      },
    };
  }

  /** Net quantity change per product AFTER a cutoff, to roll a snapshot back. */
  private async stockRollbackAfter(businessId: string, cutoff: Date) {
    const map = new Map<string, number>();
    const add = (pid: string | null, delta: number) => {
      if (!pid) return;
      map.set(pid, (map.get(pid) ?? 0) + delta);
    };

    // Sold after cutoff → add back.
    const sold = await this.db
      .select({
        productId: orderItems.productId,
        qty: sql<string>`COALESCE(SUM(${orderItems.quantity}), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orderItems.businessId, businessId),
          eq(orders.status, 'Completed'),
          gt(orders.createdAt, cutoff),
        ),
      )
      .groupBy(orderItems.productId);
    sold.forEach((r) => add(r.productId, Number(r.qty)));

    // Received after cutoff → remove.
    const received = await this.db
      .select({
        productId: goodsReceiptItems.productId,
        qty: sql<string>`COALESCE(SUM(${goodsReceiptItems.quantity}), 0)`,
      })
      .from(goodsReceiptItems)
      .innerJoin(goodsReceipts, eq(goodsReceiptItems.receiptId, goodsReceipts.id))
      .where(
        and(
          eq(goodsReceiptItems.businessId, businessId),
          gt(goodsReceipts.createdAt, cutoff),
        ),
      )
      .groupBy(goodsReceiptItems.productId);
    received.forEach((r) => add(r.productId, -Number(r.qty)));

    // Returned to supplier after cutoff (reduced stock then) → add back.
    const returned = await this.db
      .select({
        productId: supplierReturnItems.productId,
        qty: sql<string>`COALESCE(SUM(${supplierReturnItems.quantity}), 0)`,
      })
      .from(supplierReturnItems)
      .innerJoin(
        supplierReturns,
        eq(supplierReturnItems.returnId, supplierReturns.id),
      )
      .where(
        and(
          eq(supplierReturnItems.businessId, businessId),
          gt(supplierReturns.createdAt, cutoff),
        ),
      )
      .groupBy(supplierReturnItems.productId);
    returned.forEach((r) => add(r.productId, Number(r.qty)));

    // Stock-take adjustments after cutoff (diffQty applied to stock) → remove.
    const adjusted = await this.db
      .select({
        productId: stockTakeItems.productId,
        qty: sql<string>`COALESCE(SUM(${stockTakeItems.diffQty}), 0)`,
      })
      .from(stockTakeItems)
      .innerJoin(stockTakes, eq(stockTakeItems.stockTakeId, stockTakes.id))
      .where(
        and(
          eq(stockTakeItems.businessId, businessId),
          eq(stockTakes.status, 'completed'),
          gt(stockTakes.completedAt, cutoff),
        ),
      )
      .groupBy(stockTakeItems.productId);
    adjusted.forEach((r) => add(r.productId, -Number(r.qty)));

    return map;
  }

  // ─── R3: Tovarlar samaradorligi (kelim→sotuv→qoldiq) ──────────────────────
  /**
   * Per-product movement over a range: received, sold, returned-to-supplier,
   * written-off (stock-take shortages), and the closing stock. The opening stock
   * is derived so that opening + received − sold − returned − writtenOff = closing.
   */
  async getProductMovement(businessId: string, range?: DateRange) {
    const received = await this.sumByProduct(
      this.db
        .select({
          productId: goodsReceiptItems.productId,
          name: sql<string>`MAX(${goodsReceiptItems.productName})`,
          qty: sql<string>`COALESCE(SUM(${goodsReceiptItems.quantity}), 0)`,
        })
        .from(goodsReceiptItems)
        .innerJoin(goodsReceipts, eq(goodsReceiptItems.receiptId, goodsReceipts.id))
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            ...this.dateWhere(goodsReceipts.createdAt, range),
            ...this.branchWhere(goodsReceipts.branchId, range),
          ),
        )
        .groupBy(goodsReceiptItems.productId),
    );

    const sold = await this.sumByProduct(
      this.db
        .select({
          productId: orderItems.productId,
          name: sql<string>`MAX(${orderItems.productName})`,
          qty: sql<string>`COALESCE(SUM(${orderItems.quantity}), 0)`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(
          and(
            eq(orderItems.businessId, businessId),
            eq(orders.status, 'Completed'),
            ...this.dateWhere(orders.createdAt, range),
            ...this.branchWhere(orders.branchId, range),
          ),
        )
        .groupBy(orderItems.productId),
    );

    const returned = await this.sumByProduct(
      this.db
        .select({
          productId: supplierReturnItems.productId,
          name: sql<string>`MAX(${supplierReturnItems.productName})`,
          qty: sql<string>`COALESCE(SUM(${supplierReturnItems.quantity}), 0)`,
        })
        .from(supplierReturnItems)
        .innerJoin(supplierReturns, eq(supplierReturnItems.returnId, supplierReturns.id))
        .where(
          and(
            eq(supplierReturnItems.businessId, businessId),
            ...this.dateWhere(supplierReturns.createdAt, range),
          ),
        )
        .groupBy(supplierReturnItems.productId),
    );

    // Written-off = stock-take shortages (negative diffQty) completed in range.
    const writtenOff = await this.sumByProduct(
      this.db
        .select({
          productId: stockTakeItems.productId,
          name: sql<string>`MAX(${stockTakeItems.productName})`,
          qty: sql<string>`COALESCE(SUM(CASE WHEN ${stockTakeItems.diffQty} < 0 THEN -${stockTakeItems.diffQty} ELSE 0 END), 0)`,
        })
        .from(stockTakeItems)
        .innerJoin(stockTakes, eq(stockTakeItems.stockTakeId, stockTakes.id))
        .where(
          and(
            eq(stockTakeItems.businessId, businessId),
            eq(stockTakes.status, 'completed'),
            ...this.dateWhere(stockTakes.completedAt, range),
          ),
        )
        .groupBy(stockTakeItems.productId),
    );

    // Current catalog for closing stock + names.
    const catalog = await this.db
      .select({
        productId: products.id,
        name: products.name,
        code: products.code,
        closing: products.quantity,
      })
      .from(products)
      .where(eq(products.businessId, businessId));

    const ids = new Set<string>();
    catalog.forEach((c) => ids.add(c.productId));
    [received, sold, returned, writtenOff].forEach((m) =>
      m.forEach((_v, k) => ids.add(k)),
    );

    const nameOf = (id: string) =>
      catalog.find((c) => c.productId === id)?.name ??
      received.get(id)?.name ??
      sold.get(id)?.name ??
      returned.get(id)?.name ??
      writtenOff.get(id)?.name ??
      '—';

    const items = Array.from(ids).map((id) => {
      const cat = catalog.find((c) => c.productId === id);
      const rec = received.get(id)?.qty ?? 0;
      const sld = sold.get(id)?.qty ?? 0;
      const ret = returned.get(id)?.qty ?? 0;
      const wof = writtenOff.get(id)?.qty ?? 0;
      const closing = cat?.closing ?? 0;
      // opening = closing − received + sold + returned + writtenOff
      const opening = closing - rec + sld + ret + wof;
      return {
        productId: id,
        name: nameOf(id),
        code: cat?.code ?? null,
        opening,
        received: rec,
        sold: sld,
        returned: ret,
        writtenOff: wof,
        closing,
      };
    });

    items.sort((a, b) => b.sold - a.sold);
    return {from: range?.from ?? null, to: range?.to ?? null, items};
  }

  private async sumByProduct(
    query: Promise<Array<{productId: string | null; name: string; qty: string}>>,
  ) {
    const rows = await query;
    const map = new Map<string, {name: string; qty: number}>();
    rows.forEach((r) => {
      if (!r.productId) return;
      map.set(r.productId, {name: r.name, qty: Number(r.qty)});
    });
    return map;
  }

  // ─── R5: Sotuvchilar hisoboti ─────────────────────────────────────────────
  /** Per-cashier sales KPIs: orders, revenue, units, avg check, avg items/check. */
  async getSellers(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        cashierId: orders.cashierId,
        cashierName: sql<string | null>`MAX(${orders.cashierName})`,
        orderCount: sql<string>`COUNT(*)`,
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        units: sql<string>`COALESCE(SUM(${orders.itemCount}), 0)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          ...this.dateWhere(orders.createdAt, range),
          ...this.branchWhere(orders.branchId, range),
        ),
      )
      .groupBy(orders.cashierId)
      .orderBy(desc(sql`SUM(${orders.totalAmount})`));

    return rows.map((r) => {
      const orderCount = Number(r.orderCount);
      const revenue = Number(r.revenue);
      const units = Number(r.units);
      return {
        cashierId: r.cashierId,
        cashierName: r.cashierName ?? '—',
        orderCount,
        revenue,
        units,
        avgCheck: orderCount > 0 ? revenue / orderCount : 0,
        avgItemsPerCheck: orderCount > 0 ? units / orderCount : 0,
        returns: 0, // Sales-return module not built yet.
      };
    });
  }

  // ─── R6: Mijozlar hisoboti ────────────────────────────────────────────────
  /**
   * Customer KPIs for a range: per-customer order count, revenue, avg check, and
   * whether they are "new" (first-ever order falls inside the range) or returning.
   * Guest/walk-in sales (no userId) are excluded from the customer breakdown.
   */
  async getCustomers(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        userId: orders.userId,
        name: sql<string | null>`MAX(${users.name})`,
        phone: sql<string | null>`MAX(${users.phone})`,
        orderCount: sql<string>`COUNT(*)`,
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        firstEver: sql<string>`MIN(${orders.createdAt})`,
        lastOrderAt: sql<string>`MAX(${orders.createdAt})`,
      })
      .from(orders)
      .leftJoin(users, eq(orders.userId, users.id))
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          sql`${orders.userId} IS NOT NULL`,
          ...this.dateWhere(orders.createdAt, range),
          ...this.branchWhere(orders.branchId, range),
        ),
      )
      .groupBy(orders.userId)
      .orderBy(desc(sql`SUM(${orders.totalAmount})`));

    // A customer's first-EVER order (regardless of range) decides new/returning.
    const firstOrders = await this.db
      .select({
        userId: orders.userId,
        firstEver: sql<string>`MIN(${orders.createdAt})`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          sql`${orders.userId} IS NOT NULL`,
        ),
      )
      .groupBy(orders.userId);
    const firstMap = new Map(firstOrders.map((f) => [f.userId, new Date(f.firstEver)]));

    const fromDate = range?.from ? new Date(range.from) : null;
    const toDate = range?.to ? new Date(range.to) : null;
    if (toDate) toDate.setHours(23, 59, 59, 999);

    const customers = rows.map((r) => {
      const orderCount = Number(r.orderCount);
      const revenue = Number(r.revenue);
      const first = firstMap.get(r.userId);
      const isNew =
        !!first &&
        (!fromDate || first >= fromDate) &&
        (!toDate || first <= toDate);
      return {
        userId: r.userId,
        name: r.name ?? '—',
        phone: r.phone ?? null,
        orderCount,
        revenue,
        avgCheck: orderCount > 0 ? revenue / orderCount : 0,
        isNew,
        lastOrderAt: r.lastOrderAt,
      };
    });

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      customers,
      totals: {
        customers: customers.length,
        newCustomers: customers.filter((c) => c.isNew).length,
        returningCustomers: customers.filter((c) => !c.isNew).length,
        revenue: customers.reduce((s, c) => s + c.revenue, 0),
        avgCheck:
          customers.length > 0
            ? customers.reduce((s, c) => s + c.revenue, 0) /
              customers.reduce((s, c) => s + c.orderCount, 0 || 1)
            : 0,
      },
    };
  }

  // ─── R7: Importlar (prixod) hisoboti ──────────────────────────────────────
  /** Goods receipts (prixod) in a range, with supplier and settlement status. */
  async getImports(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        id: goodsReceipts.id,
        supplierName: goodsReceipts.supplierName,
        status: goodsReceipts.status,
        totalAmount: goodsReceipts.totalAmount,
        paidAmount: goodsReceipts.paidAmount,
        returnedAmount: goodsReceipts.returnedAmount,
        paymentStatus: goodsReceipts.paymentStatus,
        currency: goodsReceipts.currency,
        itemCount: goodsReceipts.itemCount,
        createdAt: goodsReceipts.createdAt,
      })
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ...this.dateWhere(goodsReceipts.createdAt, range),
          ...this.branchWhere(goodsReceipts.branchId, range),
        ),
      )
      .orderBy(desc(goodsReceipts.createdAt));

    const items = rows.map((r) => ({
      id: r.id,
      supplierName: r.supplierName ?? '—',
      status: r.status,
      totalAmount: Number(r.totalAmount),
      paidAmount: Number(r.paidAmount),
      returnedAmount: Number(r.returnedAmount),
      paymentStatus: r.paymentStatus,
      currency: r.currency,
      itemCount: r.itemCount,
      createdAt: r.createdAt,
    }));

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      items,
      totals: {
        receipts: items.length,
        totalAmount: items.reduce((s, i) => s + i.totalAmount, 0),
        paidAmount: items.reduce((s, i) => s + i.paidAmount, 0),
        returnedAmount: items.reduce((s, i) => s + i.returnedAmount, 0),
      },
    };
  }

  // ─── R7: Ta'minotchiga qaytarishlar ───────────────────────────────────────
  /** Supplier returns (qaytarishlar) in a range. */
  async getSupplierReturns(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        id: supplierReturns.id,
        supplierName: supplierReturns.supplierName,
        totalAmount: supplierReturns.totalAmount,
        currency: supplierReturns.currency,
        itemCount: supplierReturns.itemCount,
        createdAt: supplierReturns.createdAt,
      })
      .from(supplierReturns)
      .where(
        and(
          eq(supplierReturns.businessId, businessId),
          ...this.dateWhere(supplierReturns.createdAt, range),
          // Branch lives on the parent receipt.
          ...(range?.branchId
            ? [
                sql`${supplierReturns.receiptId} IN (SELECT ${goodsReceipts.id} FROM ${goodsReceipts} WHERE ${goodsReceipts.branchId} = ${range.branchId})`,
              ]
            : []),
        ),
      )
      .orderBy(desc(supplierReturns.createdAt));

    const items = rows.map((r) => ({
      id: r.id,
      supplierName: r.supplierName ?? '—',
      totalAmount: Number(r.totalAmount),
      currency: r.currency,
      itemCount: r.itemCount,
      createdAt: r.createdAt,
    }));

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      items,
      totals: {
        returns: items.length,
        totalAmount: items.reduce((s, i) => s + i.totalAmount, 0),
      },
    };
  }

  // ─── R7 / Inventarizatsiya natijalari ─────────────────────────────────────
  /** Completed stock-takes in a range (surplus/shortage/diff value). */
  async getStockTakes(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        id: stockTakes.id,
        name: stockTakes.name,
        type: stockTakes.type,
        surplusQty: stockTakes.surplusQty,
        shortageQty: stockTakes.shortageQty,
        diffValue: stockTakes.diffValue,
        createdByCashierName: stockTakes.createdByCashierName,
        completedAt: stockTakes.completedAt,
      })
      .from(stockTakes)
      .where(
        and(
          eq(stockTakes.businessId, businessId),
          eq(stockTakes.status, 'completed'),
          ...this.dateWhere(stockTakes.completedAt, range),
        ),
      )
      .orderBy(desc(stockTakes.completedAt));

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      surplusQty: Number(r.surplusQty ?? 0),
      shortageQty: Number(r.shortageQty ?? 0),
      diffValue: Number(r.diffValue ?? 0),
      createdByCashierName: r.createdByCashierName ?? '—',
      completedAt: r.completedAt,
    }));

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      items,
      totals: {
        stockTakes: items.length,
        diffValue: items.reduce((s, i) => s + i.diffValue, 0),
      },
    };
  }
}
