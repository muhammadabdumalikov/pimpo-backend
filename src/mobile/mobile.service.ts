import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  branchStock,
  branches,
  cashShifts,
  categories,
  debtPayments,
  financialCategories,
  financialTransactions,
  goodsReceiptItems,
  goodsReceipts,
  orderItems,
  orders,
  products,
  saleReturns,
  suppliers,
  units,
  userDebts,
  users,
} from '../database/schema';
import {
  BUSINESS_OFFSET_MS,
  businessBuckets,
  businessDay,
  businessDayEnd,
  businessDayStart,
} from '../common/business-time';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {IAccount} from '../business/types';
import {PermissionService} from '../permission/permission.service';
import {ReportService} from '../report/report.service';
import {OrderService} from '../order/order.service';
import {ShiftService} from '../shift/shift.service';
import {TargetService} from '../target/target.service';
import {SubscriptionService} from '../subscription/subscription.service';
import {tierAtLeast} from '../subscription/tier';
import {BranchService} from '../branch/branch.service';
import {FinanceService} from '../finance/finance.service';

export type MobilePeriod = 'today' | 'week' | 'month';

const DAY_MS = 86_400_000;
// The phone home is re-read on every tab switch and pull; 30s keeps that from
// re-running a dozen aggregates while staying fresh enough for "right now".
const HOME_TTL = 30_000;

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The current period so far, and the stretch of the previous period that is
 * exactly as long: "today until 14:30" is compared with the same weekday last
 * week until 14:30, never with a whole finished day — a morning always loses
 * to a full day and the arrow would point down until evening.
 */
export function periodWindow(period: MobilePeriod, now = new Date()) {
  const today = businessDay(now);
  let from: string;
  let prevFrom: string;
  if (period === 'today') {
    from = today;
    prevFrom = addDays(today, -7);
  } else if (period === 'week') {
    const dow = (new Date(now.getTime() + BUSINESS_OFFSET_MS).getUTCDay() + 6) % 7;
    from = addDays(today, -dow);
    prevFrom = addDays(from, -7);
  } else {
    from = `${today.slice(0, 8)}01`;
    const [y, m] = today.split('-').map(Number);
    prevFrom = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  }
  const start = businessDayStart(from);
  const prevStart = businessDayStart(prevFrom);
  let prevEnd = new Date(prevStart.getTime() + (now.getTime() - start.getTime()));
  // A short previous month must not run into the current one.
  if (prevEnd > start) prevEnd = start;
  return {from, to: today, start, prevStart, prevEnd};
}

interface OpenDebt {
  id: string;
  userId: string | null;
  name: string | null;
  phone: string | null;
  remaining: number;
  dueDate: Date | null;
}

@Injectable()
export class MobileService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly permissions: PermissionService,
    private readonly reports: ReportService,
    private readonly ordersService: OrderService,
    private readonly shifts: ShiftService,
    private readonly targets: TargetService,
    private readonly subscriptions: SubscriptionService,
    private readonly branchService: BranchService,
    private readonly finance: FinanceService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ─── Asosiy ───────────────────────────────────────────────────────────────

  async getHome(account: IAccount, period: MobilePeriod) {
    const businessId = account.businessId;
    const data = await this.cache.wrap(
      `mobile:home:${businessId}:${period}`,
      () => this.computeHome(businessId, period),
      HOME_TTL,
    );
    // The cached payload is the owner's view; each viewer gets it redacted to
    // what their role may see.
    const [profit, debts, sales, sellers] = await Promise.all([
      this.permissions.can(account, 'report:profit:view'),
      this.permissions.can(account, 'debt:read'),
      this.permissions.can(account, 'sale:read'),
      this.permissions.can(account, 'staff:sales:view'),
    ]);
    const isOwner = account.type === 'business';
    return {
      ...data,
      totals: {...data.totals, profit: profit ? data.totals.profit : null},
      attention: {
        ...data.attention,
        overdueDebts: debts ? data.attention.overdueDebts : null,
        pendingOnline: sales ? data.attention.pendingOnline : null,
        subscription: isOwner ? data.attention.subscription : null,
      },
      topSellers: sellers ? data.topSellers : null,
    };
  }

  private async computeHome(businessId: string, period: MobilePeriod) {
    const now = new Date();
    const win = periodWindow(period, now);
    const range = {from: win.from, to: win.to};
    const todayStart = businessDayStart(win.to);
    const weekFrom = addDays(win.to, -6);

    const [
      sales,
      prevRevenue,
      week,
      tier,
      stockHealth,
      debts,
      pendingOnline,
      shiftRows,
      branchRows,
      performance,
      sellerRows,
      subscription,
    ] = await Promise.all([
      this.reports.getSales(businessId, range, 'day'),
      this.revenueBetween(businessId, win.prevStart, win.prevEnd),
      this.reports.getSales(businessId, {from: weekFrom, to: win.to}, 'day'),
      this.subscriptions.getEffectiveTier(businessId),
      this.reports.getStockHealth(businessId),
      this.openDebts(businessId),
      this.pendingOnlineCount(businessId),
      this.openShiftsWithCash(businessId),
      this.branchRevenue(businessId, win.start, now),
      this.ordersService.getProductPerformance(businessId, range),
      this.reports.getSellers(businessId, range),
      this.subscriptions.getBusinessSubscription(businessId),
    ]);

    const target = tierAtLeast(tier, 'pro')
      ? await this.targets.getProgress(businessId)
      : null;

    const revenue = sales.totals.revenue;
    const bucket = (key: string) =>
      stockHealth.buckets.find((b: {key: string}) => b.key === key)?.products ?? 0;
    const overdue = debts.filter((d) => d.dueDate && d.dueDate < todayStart);

    const dayRevenue = new Map(
      week.buckets.map((b: {period: string; revenue: number}) => [b.period, b.revenue]),
    );

    let subscriptionDue: {endDate: string; daysLeft: number} | null = null;
    if (subscription?.endDate) {
      const daysLeft = Math.ceil(
        (subscription.endDate.getTime() - now.getTime()) / DAY_MS,
      );
      if (daysLeft <= 7) {
        subscriptionDue = {
          endDate: subscription.endDate.toISOString(),
          daysLeft: Math.max(0, daysLeft),
        };
      }
    }

    return {
      period,
      from: win.from,
      to: win.to,
      totals: {
        revenue,
        orderCount: sales.totals.orderCount,
        avgCheck: sales.totals.avgCheck,
        profit: sales.totals.profit as number | null,
      },
      compare: {
        from: win.prevStart.toISOString(),
        to: win.prevEnd.toISOString(),
        revenue: prevRevenue,
        deltaPct:
          prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue) * 100 : null,
      },
      target:
        target && target.revenueTarget > 0
          ? {
              revenueTarget: target.revenueTarget,
              actual: target.actual,
              achievedPct: target.achievedPct,
            }
          : null,
      attention: {
        outOfStock: bucket('out'),
        lowStock: bucket('low'),
        overdueDebts: {
          count: overdue.length,
          amount: overdue.reduce((s, d) => s + d.remaining, 0),
        } as {count: number; amount: number} | null,
        pendingOnline: pendingOnline as number | null,
        staleShifts: shiftRows
          .filter((s) => new Date(s.openedAt) < todayStart)
          .map((s) => ({
            id: s.id,
            registerName: s.registerName,
            cashierName: s.cashierName,
            openedAt: s.openedAt,
          })),
        subscription: subscriptionDue,
      },
      shifts: shiftRows,
      branches: branchRows.length >= 2 ? branchRows : [],
      daily: businessBuckets('day', weekFrom, win.to).map((date) => ({
        date,
        revenue: dayRevenue.get(date) ?? 0,
      })),
      topProducts: performance.slice(0, 5).map((p) => ({
        productId: p.productId,
        name: p.name,
        units: Number(p.unitsSold),
        revenue: Number(p.revenue),
      })),
      topSellers: [...sellerRows]
        .sort((a, b) => Number(b.revenue) - Number(a.revenue))
        .slice(0, 3)
        .map((s) => ({
          id: s.cashierId,
          name: s.cashierName,
          revenue: Number(s.revenue),
          orderCount: Number(s.orderCount),
        })) as
        | {id: string | null; name: string | null; revenue: number; orderCount: number}[]
        | null,
    };
  }

  /** Completed sales minus customer returns in [from, to) — the report's revenue. */
  private async revenueBetween(businessId: string, from: Date, to: Date) {
    const [[sold], [returned]] = await Promise.all([
      this.db
        .select({value: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`})
        .from(orders)
        .where(
          and(
            eq(orders.businessId, businessId),
            eq(orders.status, 'Completed'),
            gte(orders.createdAt, from),
            lt(orders.createdAt, to),
          ),
        ),
      this.db
        .select({value: sql<string>`COALESCE(SUM(${saleReturns.totalAmount}), 0)`})
        .from(saleReturns)
        .where(
          and(
            eq(saleReturns.businessId, businessId),
            gte(saleReturns.createdAt, from),
            lt(saleReturns.createdAt, to),
          ),
        ),
    ]);
    return Number(sold?.value ?? 0) - Number(returned?.value ?? 0);
  }

  /** Revenue per active branch over [from, to), net of that branch's returns. */
  private async branchRevenue(businessId: string, from: Date, to: Date) {
    const [list, sold, returned] = await Promise.all([
      this.branchService.findAll(businessId),
      this.db
        .select({
          branchId: orders.branchId,
          value: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.businessId, businessId),
            eq(orders.status, 'Completed'),
            gte(orders.createdAt, from),
            lt(orders.createdAt, to),
          ),
        )
        .groupBy(orders.branchId),
      this.db
        .select({
          branchId: saleReturns.branchId,
          value: sql<string>`COALESCE(SUM(${saleReturns.totalAmount}), 0)`,
        })
        .from(saleReturns)
        .where(
          and(
            eq(saleReturns.businessId, businessId),
            gte(saleReturns.createdAt, from),
            lt(saleReturns.createdAt, to),
          ),
        )
        .groupBy(saleReturns.branchId),
    ]);
    const active = list.filter((b) => b.isActive);
    const soldBy = new Map(sold.map((r) => [r.branchId, Number(r.value)]));
    const retBy = new Map(returned.map((r) => [r.branchId, Number(r.value)]));
    return active
      .map((b) => ({
        branchId: b.id,
        name: b.name,
        revenue: (soldBy.get(b.id) ?? 0) - (retBy.get(b.id) ?? 0),
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  private async pendingOnlineCount(businessId: string) {
    const [row] = await this.db
      .select({count: sql<string>`COUNT(*)`})
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.source, 'store'),
          eq(orders.status, 'Pending'),
        ),
      );
    return Number(row?.count ?? 0);
  }

  /**
   * Open shifts with the cash that should be in each drawer right now — the
   * X-report's expected UZS cash, which the shift row itself only gets at close.
   */
  private async openShiftsWithCash(businessId: string) {
    const [open, branchList] = await Promise.all([
      this.shifts.getOpenShifts(businessId),
      this.branchService.findAll(businessId),
    ]);
    const branchName = new Map(branchList.map((b) => [b.id, b.name]));
    return Promise.all(
      open.map(async (s) => {
        const report = await this.shifts.getShiftReport(businessId, s.id);
        const cash = report.reconciliation.find(
          (r) => r.method === 'cash' && r.currency === 'UZS',
        );
        return {
          id: s.id,
          registerId: s.registerId,
          registerName: s.registerName,
          branchName: s.branchId ? (branchName.get(s.branchId) ?? null) : null,
          cashierName: s.openedByCashierName ?? null,
          openedAt: new Date(s.openedAt).toISOString(),
          cash: cash?.expected ?? Number(s.openingFloat ?? 0),
        };
      }),
    );
  }

  /** Every customer debt with something still owed (amount − payments). */
  private async openDebts(businessId: string): Promise<OpenDebt[]> {
    const rows = await this.db
      .select({
        id: userDebts.id,
        userId: userDebts.userId,
        amount: userDebts.amount,
        dueDate: userDebts.dueDate,
        paid: sql<string>`COALESCE(SUM(${debtPayments.amount}), 0)`,
        name: sql<string | null>`MAX(${users.name})`,
        phone: sql<string | null>`MAX(${users.phone})`,
      })
      .from(userDebts)
      .leftJoin(debtPayments, eq(debtPayments.debtId, userDebts.id))
      .leftJoin(users, eq(users.id, userDebts.userId))
      .where(eq(userDebts.businessId, businessId))
      .groupBy(userDebts.id, userDebts.userId, userDebts.amount, userDebts.dueDate);
    return rows
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        name: r.name,
        phone: r.phone,
        remaining: Number(r.amount) - Number(r.paid),
        dueDate: r.dueDate ? new Date(r.dueDate) : null,
      }))
      .filter((d) => d.remaining > 0.01);
  }

  // ─── Pul ──────────────────────────────────────────────────────────────────

  async getMoney(account: IAccount) {
    const businessId = account.businessId;
    const [financeRead, debtRead, receiptRead] = await Promise.all([
      this.permissions.can(account, 'finance:read'),
      this.permissions.can(account, 'debt:read'),
      this.permissions.can(account, 'receipt:read'),
    ]);
    // Not cached: the owner opens "Pul" right after recording an expense or a
    // till movement and must see it — a stale balance here reads as lost money.
    const data = await this.computeMoney(businessId);
    return {
      ...data,
      accounts: financeRead ? data.accounts : null,
      expenses: financeRead ? data.expenses : null,
      customerDebt: debtRead ? data.customerDebt : null,
      supplierDebt: receiptRead ? data.supplierDebt : null,
    };
  }

  private async computeMoney(businessId: string) {
    const today = businessDay();
    const todayStart = businessDayStart(today);
    const monthFrom = `${today.slice(0, 8)}01`;

    const [accountRows, registers, open, debts, payables, pnl] = await Promise.all([
      this.finance.getAccounts(businessId),
      this.shifts.getRegisters(businessId),
      this.openShiftsWithCash(businessId),
      this.openDebts(businessId),
      this.payableRows(businessId),
      this.reports.getPnl(businessId, {from: monthFrom, to: today}),
    ]);

    const totals = new Map<string, number>();
    const items = accountRows.map((a) => {
      const balances = a.balances.map((b) => ({
        currency: b.currency,
        balance: Number(b.balance),
      }));
      for (const b of balances) {
        totals.set(b.currency, (totals.get(b.currency) ?? 0) + b.balance);
      }
      return {id: a.id, name: a.name, type: a.type, balances};
    });

    const byRegister = new Map(open.map((s) => [s.registerId, s]));
    const overdue = debts.filter((d) => d.dueDate && d.dueDate < todayStart);

    return {
      accounts: {
        totals: [...totals.entries()].map(([currency, balance]) => ({
          currency,
          balance,
        })),
        items,
      } as {
        totals: {currency: string; balance: number}[];
        items: {
          id: string;
          name: string;
          type: string;
          balances: {currency: string; balance: number}[];
        }[];
      } | null,
      registers: registers.map((r) => {
        const s = byRegister.get(r.id);
        return {
          registerId: r.id,
          registerName: r.name,
          branchName: s?.branchName ?? null,
          shiftId: s?.id ?? null,
          cashierName: s?.cashierName ?? null,
          openedAt: s?.openedAt ?? null,
          cash: s ? s.cash : null,
        };
      }),
      customerDebt: {
        amount: debts.reduce((s, d) => s + d.remaining, 0),
        debtors: new Set(debts.map((d) => d.userId ?? d.id)).size,
        overdueCount: overdue.length,
        overdueAmount: overdue.reduce((s, d) => s + d.remaining, 0),
      } as {
        amount: number;
        debtors: number;
        overdueCount: number;
        overdueAmount: number;
      } | null,
      supplierDebt: {
        amount: payables.reduce((s, p) => s + p.unpaid, 0),
        suppliers: payables.length,
      } as {amount: number; suppliers: number} | null,
      expenses: {
        month: monthFrom.slice(0, 7),
        total: Number(pnl.totalExpenses ?? 0),
        byCategory: (pnl.expenses ?? []).map(
          (e: {category: string | null; amount: number | string}) => ({
            categoryId: null as string | null,
            name: e.category ?? '—',
            amount: Number(e.amount),
          }),
        ),
      } as {
        month: string;
        total: number;
        byCategory: {categoryId: string | null; name: string; amount: number}[];
      } | null,
    };
  }

  /** What we still owe each supplier on received orders, in UZS. */
  private async payableRows(businessId: string) {
    // No bind parameters inside — safe to repeat in HAVING (see the
    // reused-sql GROUP BY gotcha in report.service).
    const unpaid = sql`GREATEST(${goodsReceipts.totalAmount} - ${goodsReceipts.paidAmount} - ${goodsReceipts.returnedAmount}, 0) * (CASE WHEN ${goodsReceipts.currency} = 'USD' THEN COALESCE(${goodsReceipts.usdRate}, 1) ELSE 1 END)`;
    const rows = await this.db
      .select({
        supplierId: goodsReceipts.supplierId,
        name: sql<string | null>`COALESCE(MAX(${suppliers.name}), MAX(${goodsReceipts.supplierName}))`,
        phone: sql<string | null>`MAX(${suppliers.phone})`,
        unpaid: sql<number>`SUM(${unpaid})::float8`,
        receipts: sql<number>`COUNT(*) FILTER (WHERE ${unpaid} > 0.01)::int`,
        oldest: sql<string | null>`MIN(${goodsReceipts.createdAt}) FILTER (WHERE ${unpaid} > 0.01)`,
      })
      .from(goodsReceipts)
      .leftJoin(suppliers, eq(suppliers.id, goodsReceipts.supplierId))
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ne(goodsReceipts.status, 'draft'),
        ),
      )
      .groupBy(goodsReceipts.supplierId)
      .having(sql`SUM(${unpaid}) > 0.01`);
    return rows
      .map((r) => ({
        supplierId: r.supplierId,
        name: r.name,
        phone: r.phone,
        unpaid: Number(r.unpaid),
        receipts: Number(r.receipts),
        oldestAt: r.oldest ? new Date(r.oldest).toISOString() : null,
      }))
      .sort((a, b) => b.unpaid - a.unpaid);
  }

  async getPayables(businessId: string) {
    return {items: await this.payableRows(businessId)};
  }

  /** Customers who owe us, overdue first, then by amount. */
  async getDebtors(businessId: string) {
    const today = businessDayStart(businessDay());
    const debts = await this.openDebts(businessId);
    const byCustomer = new Map<
      string,
      {
        userId: string | null;
        name: string | null;
        phone: string | null;
        remaining: number;
        overdueAmount: number;
        oldestDueDate: Date | null;
        debts: number;
      }
    >();
    for (const d of debts) {
      const key = d.userId ?? d.id;
      const row = byCustomer.get(key) ?? {
        userId: d.userId,
        name: d.name,
        phone: d.phone,
        remaining: 0,
        overdueAmount: 0,
        oldestDueDate: null,
        debts: 0,
      };
      row.remaining += d.remaining;
      row.debts += 1;
      if (d.dueDate && d.dueDate < today) {
        row.overdueAmount += d.remaining;
        if (!row.oldestDueDate || d.dueDate < row.oldestDueDate) {
          row.oldestDueDate = d.dueDate;
        }
      }
      byCustomer.set(key, row);
    }
    const items = [...byCustomer.values()]
      .map((r) => ({
        ...r,
        oldestDueDate: r.oldestDueDate?.toISOString() ?? null,
        overdueDays: r.oldestDueDate
          ? Math.floor((today.getTime() - r.oldestDueDate.getTime()) / DAY_MS)
          : 0,
      }))
      .sort(
        (a, b) =>
          Number(b.overdueAmount > 0) - Number(a.overdueAmount > 0) ||
          b.overdueDays - a.overdueDays ||
          b.remaining - a.remaining,
      );
    return {
      total: items.reduce((s, r) => s + r.remaining, 0),
      overdueTotal: items.reduce((s, r) => s + r.overdueAmount, 0),
      items,
    };
  }

  /** Expense categories, the ones used most in the last 90 days first. */
  async getExpenseCategories(businessId: string) {
    const since = new Date(Date.now() - 90 * DAY_MS);
    const rows = await this.db
      .select({
        id: financialCategories.id,
        name: financialCategories.name,
        uses: sql<number>`COUNT(${financialTransactions.id})::int`,
      })
      .from(financialCategories)
      .leftJoin(
        financialTransactions,
        and(
          eq(financialTransactions.categoryId, financialCategories.id),
          eq(financialTransactions.businessId, businessId),
          eq(financialTransactions.kind, 'expense'),
          gte(financialTransactions.createdAt, since),
        ),
      )
      .where(
        and(
          eq(financialCategories.businessId, businessId),
          eq(financialCategories.kind, 'expense'),
          eq(financialCategories.isActive, true),
          eq(financialCategories.isCapital, false),
        ),
      )
      .groupBy(financialCategories.id, financialCategories.name)
      .orderBy(desc(sql`COUNT(${financialTransactions.id})`), financialCategories.name);
    return rows.map((r) => ({id: r.id, name: r.name, uses: Number(r.uses)}));
  }

  // ─── Mahsulot ─────────────────────────────────────────────────────────────

  async getProduct(account: IAccount, productId: string) {
    const businessId = account.businessId;
    const [canCost, canSales] = await Promise.all([
      this.permissions.can(account, 'report:profit:view'),
      this.permissions.can(account, 'sale:read'),
    ]);

    const [p] = await this.db
      .select({
        id: products.id,
        name: products.name,
        barcode: products.barcode,
        image: products.image,
        priceIn: products.priceIn,
        priceOut: products.priceOut,
        priceWholesale: products.priceWholesale,
        priceBundle: products.priceBundle,
        quantity: products.quantity,
        lowStockThreshold: products.lowStockThreshold,
        unit: sql<string | null>`COALESCE(${units.shortName}, ${units.name})`,
      })
      .from(products)
      .leftJoin(units, eq(units.id, products.unitId))
      .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
      .limit(1);
    if (!p) throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);

    const since = new Date(Date.now() - 30 * DAY_MS);
    const [branchList, stockRows, [last], [sold]] = await Promise.all([
      this.branchService.findAll(businessId),
      this.db
        .select({branchId: branchStock.branchId, quantity: branchStock.quantity})
        .from(branchStock)
        .where(
          and(
            eq(branchStock.businessId, businessId),
            eq(branchStock.productId, productId),
          ),
        ),
      this.db
        .select({
          date: goodsReceipts.createdAt,
          supplierName: sql<string | null>`COALESCE(${suppliers.name}, ${goodsReceipts.supplierName})`,
          priceIn: goodsReceiptItems.priceIn,
          currency: goodsReceiptItems.currency,
          usdRate: goodsReceipts.usdRate,
        })
        .from(goodsReceiptItems)
        .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.receiptId))
        .leftJoin(suppliers, eq(suppliers.id, goodsReceipts.supplierId))
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            eq(goodsReceiptItems.productId, productId),
            ne(goodsReceipts.status, 'draft'),
          ),
        )
        .orderBy(desc(goodsReceipts.createdAt))
        .limit(1),
      this.db
        .select({
          units: sql<string>`COALESCE(SUM(${orderItems.quantity} - COALESCE(${orderItems.returnedQuantity}, 0)), 0)`,
          revenue: sql<string>`COALESCE(SUM(${orderItems.lineTotal}), 0)`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
          and(
            eq(orderItems.businessId, businessId),
            eq(orderItems.productId, productId),
            eq(orders.status, 'Completed'),
            gte(orders.createdAt, since),
          ),
        ),
    ]);

    const qtyBy = new Map(stockRows.map((r) => [r.branchId, Number(r.quantity)]));
    const priceIn = Number(p.priceIn);
    const priceOut = Number(p.priceOut);
    const lastPriceIn = last
      ? Number(last.priceIn) *
        (last.currency === 'USD' ? Number(last.usdRate ?? 1) : 1)
      : null;
    const num = (v: string | null) => (v == null ? null : Number(v));

    return {
      id: p.id,
      name: p.name,
      barcode: p.barcode,
      unit: p.unit,
      image: p.image,
      priceOut,
      priceWholesale: num(p.priceWholesale),
      priceBundle: num(p.priceBundle),
      priceIn: canCost ? priceIn : null,
      marginPct:
        canCost && priceOut > 0 ? ((priceOut - priceIn) / priceOut) * 100 : null,
      lowStockThreshold: p.lowStockThreshold,
      quantity: Number(p.quantity),
      branches: branchList
        .filter((b) => b.isActive)
        .map((b) => ({branchId: b.id, name: b.name, quantity: qtyBy.get(b.id) ?? 0})),
      lastReceipt: last
        ? {
            date: new Date(last.date).toISOString(),
            supplierName: last.supplierName,
            priceIn: canCost ? lastPriceIn : null,
          }
        : null,
      last30: canSales
        ? {units: Number(sold?.units ?? 0), revenue: Number(sold?.revenue ?? 0)}
        : null,
    };
  }

  // ─── Sotuv ────────────────────────────────────────────────────────────────

  /**
   * Per-day receipt count and sum for the sales list's day headers — the same
   * filters GET /orders takes, so a header always agrees with the rows under it.
   */
  async getSalesDays(
    businessId: string,
    q: {from: string; to: string; branchId?: string; registerId?: string; sellerId?: string},
  ) {
    const day = sql<string>`to_char(${orders.createdAt} + interval '5 hours', 'YYYY-MM-DD')`;
    const where = [
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
      gte(orders.createdAt, businessDayStart(q.from)),
      lte(orders.createdAt, businessDayEnd(q.to)),
    ];
    if (q.branchId) where.push(eq(orders.branchId, q.branchId));
    if (q.registerId) {
      where.push(
        inArray(
          orders.shiftId,
          this.db
            .select({id: cashShifts.id})
            .from(cashShifts)
            .where(
              and(
                eq(cashShifts.businessId, businessId),
                eq(cashShifts.registerId, q.registerId),
              ),
            ),
        ),
      );
    }
    if (q.sellerId === 'none') where.push(isNull(orders.sellerId));
    else if (q.sellerId) where.push(eq(orders.sellerId, q.sellerId));

    const rows = await this.db
      .select({
        date: day,
        count: sql<string>`COUNT(*)`,
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(and(...where))
      // Literal-only expression: identical text in SELECT and GROUP BY.
      .groupBy(sql`to_char(${orders.createdAt} + interval '5 hours', 'YYYY-MM-DD')`)
      .orderBy(desc(sql`to_char(${orders.createdAt} + interval '5 hours', 'YYYY-MM-DD')`));
    return {
      days: rows.map((r) => ({
        date: r.date,
        count: Number(r.count),
        revenue: Number(r.revenue),
      })),
    };
  }

  // ─── Hisobot: qoldiq ──────────────────────────────────────────────────────

  async getStockSummary(account: IAccount, branchId?: string) {
    const businessId = account.businessId;
    const canCost = await this.permissions.can(account, 'report:profit:view');

    type Row = {
      category: string | null;
      products: number;
      units: number;
      costValue: number;
      saleValue: number;
    };
    let rows: Row[];
    if (branchId) {
      const res = await this.db
        .select({
          category: sql<string | null>`MAX(${categories.name})`,
          categoryId: products.categoryId,
          products: sql<number>`COUNT(*)::int`,
          units: sql<number>`SUM(${branchStock.quantity})::float8`,
          costValue: sql<number>`SUM(${branchStock.quantity} * ${products.priceIn})::float8`,
          saleValue: sql<number>`SUM(${branchStock.quantity} * ${products.priceOut})::float8`,
        })
        .from(branchStock)
        .innerJoin(products, eq(products.id, branchStock.productId))
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(
          and(
            eq(branchStock.businessId, businessId),
            eq(branchStock.branchId, branchId),
            eq(products.isActive, true),
            ne(branchStock.quantity, 0),
          ),
        )
        .groupBy(products.categoryId);
      rows = res.map((r) => ({
        category: r.category,
        products: Number(r.products),
        units: Number(r.units),
        costValue: Number(r.costValue),
        saleValue: Number(r.saleValue),
      }));
    } else {
      // Whole business: the stock report's own valuation (FIFO batch cost).
      const stock = await this.reports.getStock(businessId);
      const by = new Map<string, Row>();
      for (const i of stock.items) {
        const key = i.category ?? '';
        const row = by.get(key) ?? {
          category: i.category,
          products: 0,
          units: 0,
          costValue: 0,
          saleValue: 0,
        };
        row.products += 1;
        row.units += i.quantity;
        row.costValue += i.costValue;
        row.saleValue += i.saleValue;
        by.set(key, row);
      }
      rows = [...by.values()];
    }

    rows.sort((a, b) => b.saleValue - a.saleValue);
    const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
    return {
      products: sum((r) => r.products),
      units: sum((r) => r.units),
      costValue: canCost ? sum((r) => r.costValue) : null,
      saleValue: sum((r) => r.saleValue),
      byCategory: rows.map((r) => ({
        name: r.category,
        products: r.products,
        units: r.units,
        costValue: canCost ? r.costValue : null,
        saleValue: r.saleValue,
      })),
    };
  }
}
