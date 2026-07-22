import {Injectable} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {
  orders,
  orderItems,
  products,
  categories,
  brands,
  users,
  userDebts,
  debtPayments,
  financialTransactions,
  cashShifts,
  inventoryBatches,
  goodsReceipts,
  goodsReceiptItems,
  suppliers,
  supplierReturns,
  supplierReturnItems,
  stockTakes,
  stockTakeItems,
  stockTransfers,
  branches,
  branchStock,
} from '../database/schema';
import {eq, and, or, gte, lte, gt, sql, desc} from 'drizzle-orm';
import {businessDayStart, businessDayEnd} from '../common/business-time';

export interface DateRange {
  from?: string;
  to?: string;
  /** Optional branch ("do'kon") filter; omitted = all stores. */
  branchId?: string;
}

/** One recommended inter-branch move of a single product (see getTransferSuggestions). */
export interface TransferSuggestion {
  productId: string;
  name: string;
  code: string | null;
  fromBranchId: string;
  fromBranchName: string | null;
  toBranchId: string;
  toBranchName: string | null;
  quantity: number;
  priceIn: number;
  valueMoved: number;
}

/** All suggested moves along one from→to route (maps to CreateStockTransferDto). */
export interface TransferRoute {
  fromBranchId: string;
  fromBranchName: string | null;
  toBranchId: string;
  toBranchName: string | null;
  items: TransferSuggestion[];
  products: number;
  totalQty: number;
  totalValue: number;
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
    if (range?.from) clauses.push(gte(column, businessDayStart(range.from)));
    if (range?.to) clauses.push(lte(column, businessDayEnd(range.to)));
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
    const asOf = date ? businessDayEnd(date) : null;
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

    const fromDate = range?.from ? businessDayStart(range.from) : null;
    const toDate = range?.to ? businessDayEnd(range.to) : null;

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

  // ═══ Level-1 reports (HISOBOTLAR.md §6) ═══════════════════════════════════

  // ─── R9: Sotuvlar dinamikasi (Do'kon) ─────────────────────────────────────
  /**
   * Sales over time, bucketed by business-day / week / month. Two aggregates —
   * orders (revenue/discount/units) and COGS — are computed per bucket and
   * merged, so each row carries revenue, discount, units, COGS and gross profit.
   * Buckets are truncated in the business zone (+05:00), matching how the day
   * filters bound a sale (business-time.ts). A join is NOT used for revenue (it
   * would fan out and multiply totals by item count) — COGS is a second query.
   */
  async getSales(
    businessId: string,
    range?: DateRange,
    groupBy: 'day' | 'week' | 'month' = 'day',
  ) {
    const unit =
      groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';
    const fmt = groupBy === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    // Inline the (whitelisted) unit/format as literals, not bind params. A reused
    // sql fragment re-emits its params with fresh placeholders ($1 in SELECT, $3
    // in GROUP BY), and Postgres then treats the two occurrences as different
    // expressions — tripping "orders.created_at must appear in the GROUP BY
    // clause". Literal text is byte-identical in both spots, so GROUP BY matches.
    const bucket = sql<string>`to_char(date_trunc('${sql.raw(unit)}', ${orders.createdAt} + interval '5 hours'), '${sql.raw(fmt)}')`;

    const where = and(
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
      ...this.dateWhere(orders.createdAt, range),
      ...this.branchWhere(orders.branchId, range),
    );

    const salesRows = await this.db
      .select({
        period: bucket,
        orderCount: sql<string>`COUNT(*)`,
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        discounts: sql<string>`COALESCE(SUM(${orders.discountAmount}), 0)`,
        units: sql<string>`COALESCE(SUM(${orders.itemCount}), 0)`,
      })
      .from(orders)
      .where(where)
      .groupBy(bucket)
      .orderBy(bucket);

    const cogsRows = await this.db
      .select({
        period: bucket,
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
      .where(where)
      .groupBy(bucket);

    const cogsMap = new Map(cogsRows.map((r) => [r.period, Number(r.cogs)]));

    const buckets = salesRows.map((r) => {
      const orderCount = Number(r.orderCount);
      const revenue = Number(r.revenue);
      const cogs = cogsMap.get(r.period) ?? 0;
      const profit = revenue - cogs;
      return {
        period: r.period,
        orderCount,
        revenue,
        discounts: Number(r.discounts),
        units: Number(r.units),
        cogs,
        profit,
        avgCheck: orderCount > 0 ? revenue / orderCount : 0,
        margin: revenue > 0 ? (profit / revenue) * 100 : 0,
      };
    });

    const sum = (f: (b: (typeof buckets)[number]) => number) =>
      buckets.reduce((s, b) => s + f(b), 0);
    const tRevenue = sum((b) => b.revenue);
    const tOrders = sum((b) => b.orderCount);
    const tProfit = sum((b) => b.profit);

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      groupBy,
      buckets,
      totals: {
        orderCount: tOrders,
        revenue: tRevenue,
        discounts: sum((b) => b.discounts),
        units: sum((b) => b.units),
        cogs: sum((b) => b.cogs),
        profit: tProfit,
        avgCheck: tOrders > 0 ? tRevenue / tOrders : 0,
        margin: tRevenue > 0 ? (tProfit / tRevenue) * 100 : 0,
      },
    };
  }

  // ─── R10: Soat × hafta kuni yuklama (heatmap) ─────────────────────────────
  /**
   * Order traffic by weekday × hour-of-day (business zone). Returns one cell per
   * (dow, hour) pair that has sales; the frontend lays them into a 7×24 grid.
   * dow is Postgres EXTRACT(DOW): 0 = Sunday … 6 = Saturday.
   */
  async getTraffic(businessId: string, range?: DateRange) {
    const dow = sql<string>`EXTRACT(DOW FROM ${orders.createdAt} + interval '5 hours')`;
    const hour = sql<string>`EXTRACT(HOUR FROM ${orders.createdAt} + interval '5 hours')`;

    const rows = await this.db
      .select({
        dow,
        hour,
        orderCount: sql<string>`COUNT(*)`,
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
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
      .groupBy(dow, hour);

    const cells = rows.map((r) => ({
      dow: Number(r.dow),
      hour: Number(r.hour),
      orders: Number(r.orderCount),
      revenue: Number(r.revenue),
    }));

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      cells,
      totals: {
        orders: cells.reduce((s, c) => s + c.orders, 0),
        revenue: cells.reduce((s, c) => s + c.revenue, 0),
      },
    };
  }

  // ─── R11: Kassa smenalari yig'masi (Z-hisobot) ────────────────────────────
  /**
   * Closed cash shifts in a range, plus a per-cashier rollup. The rollup surfaces
   * repeat shortages (a cashier whose reconciliation is short again and again is
   * the classic theft signal). branchId is not applicable — a shift belongs to a
   * register, not a branch — so it is ignored here.
   */
  async getShifts(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        id: cashShifts.id,
        registerName: cashShifts.registerName,
        closedByCashierId: cashShifts.closedByCashierId,
        closedByCashierName: cashShifts.closedByCashierName,
        openingFloat: cashShifts.openingFloat,
        cashIn: cashShifts.cashIn,
        cashOut: cashShifts.cashOut,
        expectedCash: cashShifts.expectedCash,
        countedCash: cashShifts.countedCash,
        difference: cashShifts.difference,
        orderCount: cashShifts.orderCount,
        openedAt: cashShifts.openedAt,
        closedAt: cashShifts.closedAt,
      })
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.businessId, businessId),
          eq(cashShifts.status, 'closed'),
          ...this.dateWhere(cashShifts.closedAt, range),
        ),
      )
      .orderBy(desc(cashShifts.closedAt));

    const shifts = rows.map((r) => ({
      id: r.id,
      registerName: r.registerName ?? '—',
      cashierName: r.closedByCashierName ?? '—',
      openingFloat: Number(r.openingFloat ?? 0),
      cashIn: Number(r.cashIn ?? 0),
      cashOut: Number(r.cashOut ?? 0),
      expectedCash: Number(r.expectedCash ?? 0),
      countedCash: Number(r.countedCash ?? 0),
      difference: Number(r.difference ?? 0),
      orderCount: Number(r.orderCount ?? 0),
      openedAt: r.openedAt,
      closedAt: r.closedAt,
    }));

    // Per-cashier rollup (keyed by closer). A recurring shortage = theft signal.
    const byMap = new Map<
      string,
      {
        cashierName: string;
        shifts: number;
        difference: number;
        shortages: number;
        surpluses: number;
      }
    >();
    rows.forEach((r) => {
      const key = r.closedByCashierId ?? r.closedByCashierName ?? '—';
      const diff = Number(r.difference ?? 0);
      const agg =
        byMap.get(key) ??
        {
          cashierName: r.closedByCashierName ?? '—',
          shifts: 0,
          difference: 0,
          shortages: 0,
          surpluses: 0,
        };
      agg.shifts += 1;
      agg.difference += diff;
      if (diff < 0) agg.shortages += 1;
      else if (diff > 0) agg.surpluses += 1;
      byMap.set(key, agg);
    });
    const byCashier = [...byMap.values()].sort(
      (a, b) => a.difference - b.difference,
    );

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      shifts,
      byCashier,
      totals: {
        shifts: shifts.length,
        difference: shifts.reduce((s, x) => s + x.difference, 0),
        cashIn: shifts.reduce((s, x) => s + x.cashIn, 0),
        cashOut: shifts.reduce((s, x) => s + x.cashOut, 0),
        shortages: shifts.filter((x) => x.difference < 0).length,
      },
    };
  }

  // ─── R12: To'lov usullari bo'yicha ────────────────────────────────────────
  /**
   * Tender received per payment method over completed orders in the range. The
   * per-method amounts live in orders.payments (a jsonb array of {method,amount})
   * which is unnested and summed — so split payments contribute their real
   * per-method share. Raw SQL is used because the unnest sits in the FROM clause.
   */
  async getPaymentMethods(businessId: string, range?: DateRange) {
    // Bind the day bounds as UTC "YYYY-MM-DD HH:mm:ss.SSS" strings, not Date
    // objects: postgres-js rejects a bare Date param inside a raw sql template
    // ("string argument must be ... Received an instance of Date"). created_at is
    // stored in UTC wall-time, and businessDayStart/End give the correct UTC
    // instant, so the stringified form compares identically to the query-builder
    // gte/lte used by the other reports.
    const toPg = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
    const conds: any[] = [
      sql`o.business_id = ${businessId}`,
      sql`o.status = 'Completed'`,
    ];
    if (range?.from) conds.push(sql`o.created_at >= ${toPg(businessDayStart(range.from))}`);
    if (range?.to) conds.push(sql`o.created_at <= ${toPg(businessDayEnd(range.to))}`);
    if (range?.branchId) conds.push(sql`o.branch_id = ${range.branchId}`);

    const rows = (await this.db.execute(sql`
      SELECT elem->>'method' AS method,
             COALESCE(SUM((elem->>'amount')::numeric), 0) AS amount,
             COUNT(DISTINCT o.id) AS orders
      FROM orders o,
           LATERAL jsonb_array_elements(COALESCE(o.payments, '[]'::jsonb)) elem
      WHERE ${sql.join(conds, sql` AND `)}
      GROUP BY elem->>'method'
      ORDER BY amount DESC
    `)) as unknown as Array<{
      method: string | null;
      amount: string;
      orders: string;
    }>;

    const rawMethods = rows.map((r) => ({
      method: r.method ?? 'other',
      amount: Number(r.amount),
      orders: Number(r.orders),
    }));
    const total = rawMethods.reduce((s, m) => s + m.amount, 0);
    const methods = rawMethods.map((m) => ({
      ...m,
      share: total > 0 ? (m.amount / total) * 100 : 0,
    }));

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      total,
      methods,
    };
  }

  // ─── R13: Chegirmalar (kassir kesimida) ───────────────────────────────────
  /**
   * Discounts given per cashier over completed orders in the range. Rate is the
   * whole-receipt discount relative to gross (subtotal before the discount).
   * Uncontrolled discounting is the fastest-leaking hole in retail — this is the
   * report an owner opens to see who is giving it away.
   */
  async getDiscounts(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        cashierId: orders.cashierId,
        cashierName: sql<string | null>`MAX(${orders.cashierName})`,
        orderCount: sql<string>`COUNT(*)`,
        discountedOrders: sql<string>`COUNT(*) FILTER (WHERE ${orders.discountAmount} > 0)`,
        discountTotal: sql<string>`COALESCE(SUM(${orders.discountAmount}), 0)`,
        gross: sql<string>`COALESCE(SUM(${orders.subtotalAmount}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
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
      .orderBy(desc(sql`SUM(${orders.discountAmount})`));

    const sellers = rows.map((r) => {
      const gross = Number(r.gross);
      const discountTotal = Number(r.discountTotal);
      return {
        cashierId: r.cashierId,
        cashierName: r.cashierName ?? '—',
        orderCount: Number(r.orderCount),
        discountedOrders: Number(r.discountedOrders),
        discountTotal,
        revenue: Number(r.revenue),
        discountRate: gross > 0 ? (discountTotal / gross) * 100 : 0,
      };
    });

    const tDiscount = sellers.reduce((s, x) => s + x.discountTotal, 0);
    const tGross = rows.reduce((s, r) => s + Number(r.gross), 0);

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      sellers,
      totals: {
        discountTotal: tDiscount,
        discountedOrders: sellers.reduce((s, x) => s + x.discountedOrders, 0),
        orderCount: sellers.reduce((s, x) => s + x.orderCount, 0),
        revenue: sellers.reduce((s, x) => s + x.revenue, 0),
        discountRate: tGross > 0 ? (tDiscount / tGross) * 100 : 0,
      },
    };
  }

  // ─── R14: Bekor qilingan cheklar ──────────────────────────────────────────
  /**
   * Cancelled orders in the range, listed with a per-cashier rollup. A cancelled
   * receipt where the cash stayed in the drawer is a classic POS fraud — this
   * gives the owner the who / when / how-much.
   */
  async getCancelled(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        id: orders.id,
        createdAt: orders.createdAt,
        cashierId: orders.cashierId,
        cashierName: orders.cashierName,
        customerName: orders.customerName,
        totalAmount: orders.totalAmount,
        itemCount: orders.itemCount,
        note: orders.note,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Cancelled'),
          ...this.dateWhere(orders.createdAt, range),
          ...this.branchWhere(orders.branchId, range),
        ),
      )
      .orderBy(desc(orders.createdAt));

    const items = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      cashierName: r.cashierName ?? '—',
      customerName: r.customerName ?? null,
      totalAmount: Number(r.totalAmount ?? 0),
      itemCount: Number(r.itemCount ?? 0),
      note: r.note ?? null,
    }));

    const byMap = new Map<
      string,
      { cashierName: string; count: number; amount: number }
    >();
    rows.forEach((r) => {
      const key = r.cashierId ?? r.cashierName ?? '—';
      const agg =
        byMap.get(key) ?? {
          cashierName: r.cashierName ?? '—',
          count: 0,
          amount: 0,
        };
      agg.count += 1;
      agg.amount += Number(r.totalAmount ?? 0);
      byMap.set(key, agg);
    });
    const byCashier = [...byMap.values()].sort((a, b) => b.amount - a.amount);

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      items,
      byCashier,
      totals: {
        count: items.length,
        amount: items.reduce((s, x) => s + x.totalAmount, 0),
      },
    };
  }

  // ═══ Level-2 reports (HISOBOTLAR.md §6, 2-daraja) ═════════════════════════

  // ─── R17: Nasiya (qarzlar) aging ──────────────────────────────────────────
  /**
   * Accounts-receivable aging snapshot (as of now). Each open debt's remaining
   * balance (amount − payments) is bucketed by how overdue it is — by dueDate,
   * or by createdAt when the debt is open-ended. Aggregated per customer (the
   * debtor list) and globally (the aging buckets). Not branch-scoped: user_debts
   * has no branch.
   */
  async getDebtAging(businessId: string) {
    const rows = await this.db
      .select({
        debtId: userDebts.id,
        userId: userDebts.userId,
        name: sql<string | null>`MAX(${users.name})`,
        phone: sql<string | null>`MAX(${users.phone})`,
        amount: userDebts.amount,
        dueDate: userDebts.dueDate,
        createdAt: userDebts.createdAt,
        paid: sql<string>`COALESCE(SUM(${debtPayments.amount}), 0)`,
      })
      .from(userDebts)
      .leftJoin(debtPayments, eq(debtPayments.debtId, userDebts.id))
      .leftJoin(users, eq(users.id, userDebts.userId))
      .where(eq(userDebts.businessId, businessId))
      // Group by the full column set (not just the PK): identical result — id is
      // unique — but valid without relying on PK functional-dependency inference.
      .groupBy(
        userDebts.id,
        userDebts.userId,
        userDebts.amount,
        userDebts.dueDate,
        userDebts.createdAt,
      );

    const now = Date.now();
    const DAY = 86_400_000;
    type Bucket = 'current' | 'd30' | 'd60' | 'd90' | 'd90plus';
    const bucketOf = (overdueDays: number): Bucket =>
      overdueDays <= 0
        ? 'current'
        : overdueDays <= 30
          ? 'd30'
          : overdueDays <= 60
            ? 'd60'
            : overdueDays <= 90
              ? 'd90'
              : 'd90plus';

    const bucketTotals: Record<Bucket, {amount: number; count: number}> = {
      current: {amount: 0, count: 0},
      d30: {amount: 0, count: 0},
      d60: {amount: 0, count: 0},
      d90: {amount: 0, count: 0},
      d90plus: {amount: 0, count: 0},
    };

    const byUser = new Map<
      string,
      {
        userId: string | null;
        name: string;
        phone: string | null;
        remaining: number;
        current: number;
        d30: number;
        d60: number;
        d90: number;
        d90plus: number;
        oldestDays: number;
      }
    >();

    for (const r of rows) {
      const remaining = Number(r.amount) - Number(r.paid);
      if (remaining <= 0.01) continue;
      const ref = r.dueDate ? new Date(r.dueDate) : new Date(r.createdAt);
      const overdueDays = Math.floor((now - ref.getTime()) / DAY);
      const bkt = bucketOf(overdueDays);
      bucketTotals[bkt].amount += remaining;
      bucketTotals[bkt].count += 1;

      const key = r.userId ?? r.debtId;
      const agg =
        byUser.get(key) ??
        {
          userId: r.userId,
          name: r.name ?? '—',
          phone: r.phone ?? null,
          remaining: 0,
          current: 0,
          d30: 0,
          d60: 0,
          d90: 0,
          d90plus: 0,
          oldestDays: 0,
        };
      agg.remaining += remaining;
      agg[bkt] += remaining;
      agg.oldestDays = Math.max(agg.oldestDays, overdueDays);
      byUser.set(key, agg);
    }

    const debtors = [...byUser.values()].sort((a, b) => b.remaining - a.remaining);
    const totalOutstanding = debtors.reduce((s, d) => s + d.remaining, 0);

    return {
      asOf: new Date(now).toISOString(),
      buckets: (['current', 'd30', 'd60', 'd90', 'd90plus'] as Bucket[]).map(
        (key) => ({key, ...bucketTotals[key]}),
      ),
      totalOutstanding,
      debtorCount: debtors.length,
      debtors,
    };
  }

  // ─── R15: O'lik va sekin zaxira ───────────────────────────────────────────
  /**
   * Products sitting in stock that have NOT sold in the last `days` days — the
   * money frozen on the shelf (qty × weighted priceIn). On-hand is the branch's
   * row when a branch is given, else the business-wide products.quantity.
   */
  async getDeadStock(businessId: string, branchId?: string, days = 30) {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const branchCond = branchId ? [eq(orders.branchId, branchId)] : [];

    // Candidate products with stock on hand.
    const candidates = branchId
      ? await this.db
          .select({
            id: products.id,
            name: products.name,
            code: products.code,
            priceIn: products.priceIn,
            qty: branchStock.quantity,
          })
          .from(products)
          .innerJoin(
            branchStock,
            and(
              eq(branchStock.productId, products.id),
              eq(branchStock.branchId, branchId),
            ),
          )
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.isActive, true),
              gt(branchStock.quantity, 0),
            ),
          )
      : await this.db
          .select({
            id: products.id,
            name: products.name,
            code: products.code,
            priceIn: products.priceIn,
            qty: products.quantity,
          })
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.isActive, true),
              gt(products.quantity, 0),
            ),
          );

    // Last-ever sale date per product.
    const lastSaleRows = await this.db
      .select({
        productId: orderItems.productId,
        last: sql<string>`MAX(${orders.createdAt})`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          ...branchCond,
        ),
      )
      .groupBy(orderItems.productId);
    const lastMap = new Map(
      lastSaleRows.map((r) => [r.productId, new Date(r.last)]),
    );

    const items = candidates
      .map((p) => {
        const qty = Number(p.qty);
        const priceIn = Number(p.priceIn);
        const last = p.id ? lastMap.get(p.id) : undefined;
        const daysSinceSale = last
          ? Math.floor((Date.now() - last.getTime()) / 86_400_000)
          : null;
        return {
          productId: p.id,
          name: p.name,
          code: p.code,
          quantity: qty,
          priceIn,
          frozenValue: qty * priceIn,
          lastSaleAt: last ? last.toISOString() : null,
          daysSinceSale,
        };
      })
      // Dead/slow = never sold, or last sale older than the window.
      .filter((p) => p.daysSinceSale === null || p.daysSinceSale >= days)
      .sort((a, b) => b.frozenValue - a.frozenValue);

    return {
      days,
      items,
      totals: {
        products: items.length,
        units: items.reduce((s, i) => s + i.quantity, 0),
        frozenValue: items.reduce((s, i) => s + i.frozenValue, 0),
      },
    };
  }

  // ─── R16: Qayta buyurtma / tugash prognozi ────────────────────────────────
  /**
   * Reorder suggestions. Sales velocity = units sold in the last `days` days /
   * `days`. Days-of-stock = on-hand / velocity. A product is flagged when it is
   * at/below its low-stock threshold, or will run out within `coverDays`. The
   * suggested order quantity tops it back up to a `coverDays` buffer.
   */
  async getReorder(
    businessId: string,
    branchId?: string,
    days = 30,
    coverDays = 14,
  ) {
    const since = new Date(Date.now() - days * 86_400_000);
    const branchCond = branchId ? [eq(orders.branchId, branchId)] : [];

    const candidates = branchId
      ? await this.db
          .select({
            id: products.id,
            name: products.name,
            code: products.code,
            threshold: products.lowStockThreshold,
            supplierId: products.supplierId,
            priceIn: products.priceIn,
            qty: branchStock.quantity,
          })
          .from(products)
          .innerJoin(
            branchStock,
            and(
              eq(branchStock.productId, products.id),
              eq(branchStock.branchId, branchId),
            ),
          )
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.isActive, true),
            ),
          )
      : await this.db
          .select({
            id: products.id,
            name: products.name,
            code: products.code,
            threshold: products.lowStockThreshold,
            supplierId: products.supplierId,
            priceIn: products.priceIn,
            qty: products.quantity,
          })
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.isActive, true),
            ),
          );

    const soldRows = await this.db
      .select({
        productId: orderItems.productId,
        units: sql<string>`COALESCE(SUM(${orderItems.quantity}), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          gte(orders.createdAt, since),
          ...branchCond,
        ),
      )
      .groupBy(orderItems.productId);
    const soldMap = new Map(soldRows.map((r) => [r.productId, Number(r.units)]));

    // First time each product was stocked (earliest inventory batch), so we can
    // correct velocity for products introduced mid-window (see availableDays).
    const firstStockRows = await this.db
      .select({
        productId: inventoryBatches.productId,
        first: sql<string>`MIN(${inventoryBatches.createdAt})`,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          ...(branchId ? [eq(inventoryBatches.branchId, branchId)] : []),
        ),
      )
      .groupBy(inventoryBatches.productId);
    const firstStockMap = new Map(
      firstStockRows.map((r) => [r.productId, new Date(r.first)]),
    );

    // Supplier names, to group the reorder list into per-supplier draft orders.
    const supplierRows = await this.db
      .select({id: suppliers.id, name: suppliers.name})
      .from(suppliers)
      .where(eq(suppliers.businessId, businessId));
    const supplierMap = new Map(supplierRows.map((s) => [s.id, s.name]));

    const now = Date.now();
    const items = candidates
      .map((p) => {
        const qty = Number(p.qty);
        const threshold = p.threshold === null ? null : Number(p.threshold);
        const priceIn = Number(p.priceIn);
        const soldWindow = p.id ? (soldMap.get(p.id) ?? 0) : 0;

        // Days the product was actually sellable inside the window. A product
        // first stocked mid-window must not be averaged over the full window, or
        // its velocity — and the suggested order — is badly understated. Clamp to
        // [1, days]. NOTE: mid-window stockouts of long-standing products are NOT
        // corrected — we have no daily stock ledger, only the first-batch date.
        const firstStockAt = p.id ? firstStockMap.get(p.id) : undefined;
        let availableDays = days;
        if (firstStockAt && firstStockAt.getTime() > since.getTime()) {
          availableDays = Math.max(
            1,
            Math.min(days, (now - firstStockAt.getTime()) / 86_400_000),
          );
        }
        const velocity = soldWindow / availableDays; // units per day

        const daysOfStock = velocity > 0 ? qty / velocity : null;
        const belowThreshold = threshold !== null && qty <= threshold;
        const runningOut = daysOfStock !== null && daysOfStock < coverDays;
        const suggestedQty =
          velocity > 0 ? Math.max(0, Math.ceil(velocity * coverDays - qty)) : 0;
        const supplierId = p.supplierId ?? null;
        return {
          productId: p.id,
          name: p.name,
          code: p.code,
          supplierId,
          supplierName: supplierId ? (supplierMap.get(supplierId) ?? null) : null,
          quantity: qty,
          threshold,
          priceIn,
          soldWindow,
          availableDays,
          dailyVelocity: velocity,
          daysOfStock,
          suggestedQty,
          estimatedCost: suggestedQty * priceIn,
          flagged: belowThreshold || runningOut,
        };
      })
      .filter((p) => p.flagged)
      // Most urgent first: soonest to run out.
      .sort(
        (a, b) =>
          (a.daysOfStock ?? Number.POSITIVE_INFINITY) -
          (b.daysOfStock ?? Number.POSITIVE_INFINITY),
      );

    // Group the flagged items into per-supplier draft purchase orders. Products
    // with no default supplier fall into a single null-supplier bucket the owner
    // still needs to assign. Ordered by spend (largest draft order first).
    const groups = new Map<
      string,
      {
        supplierId: string | null;
        supplierName: string | null;
        items: typeof items;
        products: number;
        suggestedUnits: number;
        estimatedCost: number;
      }
    >();
    for (const it of items) {
      const key = it.supplierId ?? '__none__';
      let g = groups.get(key);
      if (!g) {
        g = {
          supplierId: it.supplierId,
          supplierName: it.supplierName,
          items: [],
          products: 0,
          suggestedUnits: 0,
          estimatedCost: 0,
        };
        groups.set(key, g);
      }
      g.items.push(it);
      g.products += 1;
      g.suggestedUnits += it.suggestedQty;
      g.estimatedCost += it.estimatedCost;
    }
    const bySupplier = [...groups.values()].sort(
      (a, b) => b.estimatedCost - a.estimatedCost,
    );

    return {
      days,
      coverDays,
      items,
      bySupplier,
      totals: {
        products: items.length,
        suggestedUnits: items.reduce((s, i) => s + i.suggestedQty, 0),
        estimatedCost: items.reduce((s, i) => s + i.estimatedCost, 0),
      },
    };
  }

  // ─── Transfer suggestions (inter-branch rebalancing) ──────────────────────
  /**
   * Recommends inter-branch stock transfers. For every product it computes, per
   * branch: on-hand, sales velocity (stockout-corrected like getReorder), and a
   * `coverDays` target (`need = velocity × coverDays`). A branch with more than
   * its target is a DONOR (excess = qty − need); one below its target is a
   * RECEIVER (deficit = need − qty). For each product with both, stock is greedily
   * moved from the most-overstocked branches to the most-starved ones — so slow/
   * dead stock in one branch covers a stockout in another instead of a purchase.
   * Suggestions are grouped by from→to route, matching CreateStockTransferDto so
   * a route can later be turned into a real transfer in one call.
   */
  async getTransferSuggestions(businessId: string, days = 30, coverDays = 14) {
    const since = new Date(Date.now() - days * 86_400_000);

    const branchRows = await this.db
      .select({id: branches.id, name: branches.name})
      .from(branches)
      .where(
        and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
      );
    // Nothing to rebalance with fewer than two branches.
    if (branchRows.length < 2) {
      return {
        days,
        coverDays,
        suggestions: [] as TransferSuggestion[],
        byRoute: [] as TransferRoute[],
        totals: {routes: 0, products: 0, moves: 0, totalValue: 0},
      };
    }
    const branchName = new Map(branchRows.map((b) => [b.id, b.name]));

    // On-hand per (product, branch).
    const stockRows = await this.db
      .select({
        productId: branchStock.productId,
        branchId: branchStock.branchId,
        qty: branchStock.quantity,
      })
      .from(branchStock)
      .innerJoin(products, eq(products.id, branchStock.productId))
      .where(
        and(
          eq(branchStock.businessId, businessId),
          eq(products.isActive, true),
        ),
      );

    // Units sold in the window per (product, branch).
    const soldRows = await this.db
      .select({
        productId: orderItems.productId,
        branchId: orders.branchId,
        units: sql<string>`COALESCE(SUM(${orderItems.quantity}), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          gte(orders.createdAt, since),
        ),
      )
      .groupBy(orderItems.productId, orders.branchId);

    // Earliest batch per (product, branch) → correct velocity for stock that was
    // only introduced to a branch mid-window (same rule as getReorder).
    const firstStockRows = await this.db
      .select({
        productId: inventoryBatches.productId,
        branchId: inventoryBatches.branchId,
        first: sql<string>`MIN(${inventoryBatches.createdAt})`,
      })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.businessId, businessId))
      .groupBy(inventoryBatches.productId, inventoryBatches.branchId);

    const productRows = await this.db
      .select({
        id: products.id,
        name: products.name,
        code: products.code,
        priceIn: products.priceIn,
      })
      .from(products)
      .where(
        and(eq(products.businessId, businessId), eq(products.isActive, true)),
      );
    const productMeta = new Map(productRows.map((p) => [p.id, p]));

    const key = (pid: string, bid: string | null) => `${pid}|${bid ?? ''}`;
    const firstStockMap = new Map(
      firstStockRows.map((r) => [
        key(r.productId, r.branchId),
        new Date(r.first),
      ]),
    );

    // Collect the set of branches each product appears in (stock or sales).
    const perProduct = new Map<
      string,
      Map<string, {qty: number; sold: number}>
    >();
    const touch = (pid: string, bid: string) => {
      let m = perProduct.get(pid);
      if (!m) {
        m = new Map();
        perProduct.set(pid, m);
      }
      let cell = m.get(bid);
      if (!cell) {
        cell = {qty: 0, sold: 0};
        m.set(bid, cell);
      }
      return cell;
    };
    for (const r of stockRows) touch(r.productId, r.branchId).qty = Number(r.qty);
    for (const r of soldRows) {
      if (r.productId && r.branchId)
        touch(r.productId, r.branchId).sold = Number(r.units);
    }

    const now = Date.now();
    type Node = {branchId: string; excess: number; deficit: number};
    const suggestions: TransferSuggestion[] = [];

    for (const [productId, byBranch] of perProduct) {
      const meta = productMeta.get(productId);
      if (!meta) continue;
      const priceIn = Number(meta.priceIn);

      const donors: Node[] = [];
      const receivers: Node[] = [];
      for (const [branchId, cell] of byBranch) {
        // Days the product was sellable in this branch inside the window.
        const firstAt = firstStockMap.get(key(productId, branchId));
        let availableDays = days;
        if (firstAt && firstAt.getTime() > since.getTime()) {
          availableDays = Math.max(
            1,
            Math.min(days, (now - firstAt.getTime()) / 86_400_000),
          );
        }
        const velocity = cell.sold / availableDays;
        const need = Math.ceil(velocity * coverDays);
        const excess = cell.qty - need;
        if (excess > 0) donors.push({branchId, excess, deficit: 0});
        else if (need - cell.qty > 0)
          receivers.push({branchId, excess: 0, deficit: need - cell.qty});
      }
      if (donors.length === 0 || receivers.length === 0) continue;

      // Move from the most-overstocked branch to the most-starved one first.
      donors.sort((a, b) => b.excess - a.excess);
      receivers.sort((a, b) => b.deficit - a.deficit);

      let di = 0;
      for (const rcv of receivers) {
        let remainingDeficit = rcv.deficit;
        while (remainingDeficit > 0 && di < donors.length) {
          const don = donors[di];
          if (don.excess <= 0) {
            di++;
            continue;
          }
          const move = Math.min(don.excess, remainingDeficit);
          // Round to 3 decimals (whole grams / whole units) to match stock model.
          const qty = Math.round(move * 1000) / 1000;
          if (qty > 0) {
            suggestions.push({
              productId,
              name: meta.name,
              code: meta.code,
              fromBranchId: don.branchId,
              fromBranchName: branchName.get(don.branchId) ?? null,
              toBranchId: rcv.branchId,
              toBranchName: branchName.get(rcv.branchId) ?? null,
              quantity: qty,
              priceIn,
              valueMoved: qty * priceIn,
            });
          }
          don.excess -= move;
          remainingDeficit -= move;
          if (don.excess <= 0) di++;
        }
      }
    }

    // Group per from→to route — one route maps to one CreateStockTransferDto.
    const routes = new Map<string, TransferRoute>();
    for (const s of suggestions) {
      const rk = `${s.fromBranchId}>${s.toBranchId}`;
      let r = routes.get(rk);
      if (!r) {
        r = {
          fromBranchId: s.fromBranchId,
          fromBranchName: s.fromBranchName,
          toBranchId: s.toBranchId,
          toBranchName: s.toBranchName,
          items: [],
          products: 0,
          totalQty: 0,
          totalValue: 0,
        };
        routes.set(rk, r);
      }
      r.items.push(s);
      r.products += 1;
      r.totalQty += s.quantity;
      r.totalValue += s.valueMoved;
    }
    const byRoute = [...routes.values()].sort(
      (a, b) => b.totalValue - a.totalValue,
    );

    return {
      days,
      coverDays,
      suggestions,
      byRoute,
      totals: {
        routes: byRoute.length,
        products: suggestions.length,
        moves: suggestions.length,
        totalValue: suggestions.reduce((s, i) => s + i.valueMoved, 0),
      },
    };
  }

  // ─── R18: Ta'minotchilar hisoboti ─────────────────────────────────────────
  /**
   * Per-supplier purchasing over goods receipts in the range: purchased, paid,
   * returned, and outstanding (what we still owe = purchased − paid − returned).
   * Grouped by the receipt's supplier snapshot, so deleted suppliers still show.
   */
  async getSuppliers(businessId: string, range?: DateRange) {
    const rows = await this.db
      .select({
        supplierId: goodsReceipts.supplierId,
        supplierName: sql<string | null>`MAX(${goodsReceipts.supplierName})`,
        receipts: sql<string>`COUNT(*)`,
        purchased: sql<string>`COALESCE(SUM(${goodsReceipts.totalAmount}), 0)`,
        paid: sql<string>`COALESCE(SUM(${goodsReceipts.paidAmount}), 0)`,
        returned: sql<string>`COALESCE(SUM(${goodsReceipts.returnedAmount}), 0)`,
      })
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ...this.dateWhere(goodsReceipts.createdAt, range),
          ...this.branchWhere(goodsReceipts.branchId, range),
        ),
      )
      .groupBy(goodsReceipts.supplierId)
      .orderBy(
        desc(
          sql`SUM(${goodsReceipts.totalAmount} - ${goodsReceipts.paidAmount} - ${goodsReceipts.returnedAmount})`,
        ),
      );

    const suppliers = rows.map((r) => {
      const purchased = Number(r.purchased);
      const paid = Number(r.paid);
      const returned = Number(r.returned);
      return {
        supplierId: r.supplierId,
        supplierName: r.supplierName ?? '—',
        receipts: Number(r.receipts),
        purchased,
        paid,
        returned,
        outstanding: purchased - paid - returned,
      };
    });

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      suppliers,
      totals: {
        suppliers: suppliers.length,
        purchased: suppliers.reduce((s, x) => s + x.purchased, 0),
        paid: suppliers.reduce((s, x) => s + x.paid, 0),
        returned: suppliers.reduce((s, x) => s + x.returned, 0),
        outstanding: suppliers.reduce((s, x) => s + x.outstanding, 0),
      },
    };
  }

  // ─── R19: Kategoriya / brend kesimida sotuv va marja ──────────────────────
  /**
   * Sales and margin grouped by category or brand (dimension). Revenue is line
   * totals; COGS is the per-line snapshot (falling back to current priceIn).
   * Products deleted after sale group under "—" (their name snapshot is on the
   * order line, but category/brand come from the live product row).
   */
  async getAssortment(
    businessId: string,
    range?: DateRange,
    dimension: 'category' | 'brand' = 'category',
  ) {
    const cogsExpr = sql<string>`COALESCE(SUM(
      CASE WHEN ${orderItems.costTotal} > 0
        THEN ${orderItems.costTotal}
        ELSE ${orderItems.quantity} * COALESCE(${products.priceIn}, 0)
      END
    ), 0)`;
    const revenueExpr = sql<string>`COALESCE(SUM(${orderItems.lineTotal}), 0)`;
    const unitsExpr = sql<string>`COALESCE(SUM(${orderItems.quantity}), 0)`;
    const where = and(
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
      ...this.dateWhere(orders.createdAt, range),
      ...this.branchWhere(orders.branchId, range),
    );

    const rows =
      dimension === 'brand'
        ? await this.db
            .select({
              key: products.brandId,
              name: sql<string | null>`MAX(${brands.name})`,
              revenue: revenueExpr,
              cogs: cogsExpr,
              units: unitsExpr,
            })
            .from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .leftJoin(products, eq(orderItems.productId, products.id))
            .leftJoin(brands, eq(brands.id, products.brandId))
            .where(where)
            .groupBy(products.brandId)
            .orderBy(desc(sql`SUM(${orderItems.lineTotal})`))
        : await this.db
            .select({
              key: products.categoryId,
              name: sql<string | null>`MAX(${categories.name})`,
              revenue: revenueExpr,
              cogs: cogsExpr,
              units: unitsExpr,
            })
            .from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .leftJoin(products, eq(orderItems.productId, products.id))
            .leftJoin(
              categories,
              and(
                eq(categories.id, products.categoryId),
                eq(categories.businessId, businessId),
              ),
            )
            .where(where)
            .groupBy(products.categoryId)
            .orderBy(desc(sql`SUM(${orderItems.lineTotal})`));

    const groups = rows.map((r) => {
      const revenue = Number(r.revenue);
      const cogs = Number(r.cogs);
      const profit = revenue - cogs;
      return {
        key: r.key,
        name: r.name ?? '—',
        revenue,
        cogs,
        profit,
        units: Number(r.units),
        margin: revenue > 0 ? (profit / revenue) * 100 : 0,
      };
    });

    const totalRevenue = groups.reduce((s, g) => s + g.revenue, 0);
    const withShare = groups.map((g) => ({
      ...g,
      share: totalRevenue > 0 ? (g.revenue / totalRevenue) * 100 : 0,
    }));

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      dimension,
      groups: withShare,
      totals: {
        groups: groups.length,
        revenue: totalRevenue,
        cogs: groups.reduce((s, g) => s + g.cogs, 0),
        profit: groups.reduce((s, g) => s + g.profit, 0),
        units: groups.reduce((s, g) => s + g.units, 0),
      },
    };
  }

  // ─── R20: Filiallar taqqoslash ────────────────────────────────────────────
  /**
   * Side-by-side branch comparison for the range: revenue, orders, avg check,
   * profit and margin (from sales), plus current stock value (a live snapshot,
   * qty × weighted priceIn — not range-bound). Orders with no branch (legacy)
   * fold into a synthetic "—" row.
   */
  async getBranchComparison(businessId: string, range?: DateRange) {
    const salesWhere = and(
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
      ...this.dateWhere(orders.createdAt, range),
    );

    const salesRows = await this.db
      .select({
        branchId: orders.branchId,
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        orderCount: sql<string>`COUNT(*)`,
        units: sql<string>`COALESCE(SUM(${orders.itemCount}), 0)`,
      })
      .from(orders)
      .where(salesWhere)
      .groupBy(orders.branchId);

    const cogsRows = await this.db
      .select({
        branchId: orders.branchId,
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
      .where(salesWhere)
      .groupBy(orders.branchId);
    const cogsMap = new Map(cogsRows.map((r) => [r.branchId, Number(r.cogs)]));

    // Current stock value per branch (snapshot).
    const stockRows = await this.db
      .select({
        branchId: branchStock.branchId,
        stockValue: sql<string>`COALESCE(SUM(${branchStock.quantity} * ${products.priceIn}), 0)`,
      })
      .from(branchStock)
      .innerJoin(products, eq(products.id, branchStock.productId))
      .where(eq(branchStock.businessId, businessId))
      .groupBy(branchStock.branchId);
    const stockMap = new Map(stockRows.map((r) => [r.branchId, Number(r.stockValue)]));

    const branchRows = await this.db
      .select({id: branches.id, name: branches.name})
      .from(branches)
      .where(eq(branches.businessId, businessId));
    const nameMap = new Map(branchRows.map((b) => [b.id, b.name]));

    // Union of every branch id that appears in any source.
    const ids = new Set<string | null>([
      ...salesRows.map((r) => r.branchId),
      ...stockMap.keys(),
      ...branchRows.map((b) => b.id),
    ]);

    const rows = [...ids].map((id) => {
      const sales = salesRows.find((r) => r.branchId === id);
      const revenue = sales ? Number(sales.revenue) : 0;
      const orderCount = sales ? Number(sales.orderCount) : 0;
      const cogs = cogsMap.get(id) ?? 0;
      const profit = revenue - cogs;
      return {
        branchId: id,
        branchName: (id && nameMap.get(id)) || '—',
        revenue,
        orderCount,
        avgCheck: orderCount > 0 ? revenue / orderCount : 0,
        profit,
        margin: revenue > 0 ? (profit / revenue) * 100 : 0,
        stockValue: (id != null ? stockMap.get(id) : undefined) ?? 0,
      };
    });
    rows.sort((a, b) => b.revenue - a.revenue);

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      branches: rows,
      totals: {
        branches: rows.length,
        revenue: rows.reduce((s, x) => s + x.revenue, 0),
        orderCount: rows.reduce((s, x) => s + x.orderCount, 0),
        profit: rows.reduce((s, x) => s + x.profit, 0),
        stockValue: rows.reduce((s, x) => s + x.stockValue, 0),
      },
    };
  }

  // ─── R23: Transferlar (filiallararo ko'chirishlar) ────────────────────────
  /**
   * Inter-branch stock transfers in the range. Value is the COGS (weighted cost)
   * of the moved goods (a snapshot on the document). The branch filter matches
   * transfers where the branch is EITHER the source or the destination.
   */
  async getTransfers(businessId: string, range?: DateRange) {
    const branchCond = range?.branchId
      ? [
          or(
            eq(stockTransfers.fromBranchId, range.branchId),
            eq(stockTransfers.toBranchId, range.branchId),
          ),
        ]
      : [];

    const rows = await this.db
      .select({
        id: stockTransfers.id,
        fromBranchName: stockTransfers.fromBranchName,
        toBranchName: stockTransfers.toBranchName,
        itemCount: stockTransfers.itemCount,
        totalQty: stockTransfers.totalQty,
        totalValue: stockTransfers.totalValue,
        cashierName: stockTransfers.createdByCashierName,
        note: stockTransfers.note,
        createdAt: stockTransfers.createdAt,
      })
      .from(stockTransfers)
      .where(
        and(
          eq(stockTransfers.businessId, businessId),
          ...this.dateWhere(stockTransfers.createdAt, range),
          ...branchCond,
        ),
      )
      .orderBy(desc(stockTransfers.createdAt));

    const items = rows.map((r) => ({
      id: r.id,
      fromBranchName: r.fromBranchName ?? '—',
      toBranchName: r.toBranchName ?? '—',
      itemCount: Number(r.itemCount ?? 0),
      totalQty: Number(r.totalQty ?? 0),
      totalValue: Number(r.totalValue ?? 0),
      cashierName: r.cashierName ?? '—',
      note: r.note ?? null,
      createdAt: r.createdAt,
    }));

    return {
      from: range?.from ?? null,
      to: range?.to ?? null,
      items,
      totals: {
        transfers: items.length,
        qty: items.reduce((s, i) => s + i.totalQty, 0),
        value: items.reduce((s, i) => s + i.totalValue, 0),
      },
    };
  }
}
