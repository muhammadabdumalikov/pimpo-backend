import {Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {and, asc, desc, eq, gte, lt, ne, or, sql} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {BUSINESS_UTC_OFFSET} from '../common/business-time';
import {DatabaseService} from '../database/database.service';
import {
  staff,
  branches,
  orders,
  orderItems,
  payrollEntries,
  payrollSettings,
  businesses,
  type PayrollEntry,
  type PayrollSettings,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {FinanceService} from '../finance/finance.service';

type DbTx = Parameters<
  Parameters<DatabaseService['db']['transaction']>[0]
>[0];

/** Entry types that INCREASE what the business owes the employee. */
const CREDIT_TYPES = ['accrual', 'bonus'] as const;

export type PayrollEntryType =
  | (typeof CREDIT_TYPES)[number]
  // Types that DECREASE it: payments, advances and withholdings.
  | 'payment'
  | 'advance'
  | 'deduction';

/** +1 if the type grows the balance, -1 if it shrinks it. */
function signOf(type: PayrollEntryType): 1 | -1 {
  return (CREDIT_TYPES as readonly string[]).includes(type) ? 1 : -1;
}

export interface AccrualPreviewRow {
  staffId: string;
  staffName: string;
  position: string | null;
  salaryType: string;
  /** Fixed monthly wage portion. */
  baseAmount: number;
  /** Revenue (or profit) the employee personally generated in the period. */
  salesBase: number;
  percentApplied: number;
  /** salesBase × percentApplied / 100. */
  salesAmount: number;
  total: number;
  percentBase: string;
  /** True when this employee was already accrued for this month. */
  alreadyAccrued: boolean;
}

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly financeService: FinanceService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ─── Period helpers ───────────────────────────────────────────────────────

  /**
   * Half-open [start, end) UTC instants bounding a 'YYYY-MM' month in the
   * business zone. Half-open (not BETWEEN) so a sale rung at 23:59:59.999 on
   * the last day belongs to exactly one month — no double-counting at the seam.
   */
  private monthRange(period: string): {start: Date; end: Date} {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new AppException(ErrorCode.PAYROLL_PERIOD_INVALID);
    }
    const [year, month] = period.split('-').map(Number);
    const start = new Date(
      `${period}-01T00:00:00.000${BUSINESS_UTC_OFFSET}`,
    );
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const end = new Date(
      `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00.000${BUSINESS_UTC_OFFSET}`,
    );
    return {start, end};
  }

  /** 'YYYY-MM' of the current month in the business zone. */
  private currentPeriod(): string {
    const now = new Date();
    const local = new Date(
      now.getTime() + 5 * 60 * 60 * 1000, // Asia/Tashkent, fixed +05:00
    );
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private assertNotFuture(period: string) {
    if (period > this.currentPeriod()) {
      throw new AppException(ErrorCode.PAYROLL_PERIOD_IN_FUTURE);
    }
  }

  // ─── Personal sales ───────────────────────────────────────────────────────

  /**
   * Revenue and COGS per cashier for a period, keyed by staff id.
   *
   * Revenue and COGS are two separate queries on purpose: order_items is
   * one-to-many against orders, so a single joined query would repeat each
   * order's total_amount once per line and inflate revenue by the line count.
   */
  private async personalSales(
    businessId: string,
    period: string,
  ): Promise<Map<string, {revenue: number; cogs: number}>> {
    const {start, end} = this.monthRange(period);
    const inPeriod = and(
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
      gte(orders.createdAt, start),
      lt(orders.createdAt, end),
    );

    const [revenueRows, cogsRows] = await Promise.all([
      this.db
        .select({
          cashierId: orders.cashierId,
          revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        })
        .from(orders)
        .where(inPeriod)
        .groupBy(orders.cashierId),
      this.db
        .select({
          cashierId: orders.cashierId,
          cogs: sql<string>`COALESCE(SUM(${orderItems.costTotal}), 0)`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(inPeriod)
        .groupBy(orders.cashierId),
    ]);

    const map = new Map<string, {revenue: number; cogs: number}>();
    for (const row of revenueRows) {
      if (!row.cashierId) continue; // storefront / guest orders
      map.set(row.cashierId, {revenue: Number(row.revenue), cogs: 0});
    }
    for (const row of cogsRows) {
      if (!row.cashierId) continue;
      const entry = map.get(row.cashierId);
      if (entry) entry.cogs = Number(row.cogs);
    }
    return map;
  }

  // ─── Accrual run ──────────────────────────────────────────────────────────

  /**
   * Compute what every payroll-enabled employee has earned in `period`.
   * Pure read — nothing is written, so the UI can show the run for review
   * before it is committed.
   */
  async previewPeriod(
    businessId: string,
    period: string,
  ): Promise<{period: string; rows: AccrualPreviewRow[]; total: number}> {
    this.monthRange(period); // validates the format

    const [members, sales, accrued] = await Promise.all([
      this.db
        .select()
        .from(staff)
        .where(
          and(
            eq(staff.businessId, businessId),
            eq(staff.isActive, true),
            sql`${staff.salaryType} <> 'none'`,
          ),
        )
        .orderBy(asc(staff.name)),
      this.personalSales(businessId, period),
      this.db
        .select({staffId: payrollEntries.staffId})
        .from(payrollEntries)
        .where(
          and(
            eq(payrollEntries.businessId, businessId),
            eq(payrollEntries.type, 'accrual'),
            eq(payrollEntries.periodMonth, period),
          ),
        ),
    ]);

    const accruedIds = new Set(accrued.map((a) => a.staffId));

    const rows: AccrualPreviewRow[] = members.map((m) => {
      const personal = sales.get(m.id) ?? {revenue: 0, cogs: 0};
      const wantsPercent =
        m.salaryType === 'percent' || m.salaryType === 'mixed';
      const wantsBase = m.salaryType === 'fixed' || m.salaryType === 'mixed';

      const salesBase = wantsPercent
        ? m.percentBase === 'profit'
          ? personal.revenue - personal.cogs
          : personal.revenue
        : 0;
      const percentApplied = wantsPercent ? Number(m.salesPercent) : 0;
      // A loss-making month on a profit basis must not create a negative
      // "bonus" that silently eats into the fixed wage.
      const salesAmount = Math.max(0, (salesBase * percentApplied) / 100);
      const baseAmount = wantsBase ? Number(m.baseSalary) : 0;

      return {
        staffId: m.id,
        staffName: m.name,
        position: m.position,
        salaryType: m.salaryType,
        baseAmount,
        salesBase,
        percentApplied,
        salesAmount: Math.round(salesAmount * 100) / 100,
        total: Math.round((baseAmount + salesAmount) * 100) / 100,
        percentBase: m.percentBase,
        alreadyAccrued: accruedIds.has(m.id),
      };
    });

    return {
      period,
      rows,
      total: rows
        .filter((r) => !r.alreadyAccrued)
        .reduce((sum, r) => sum + r.total, 0),
    };
  }

  /**
   * Commit the accrual for `period`. Employees already accrued for that month
   * are skipped, so re-running is safe (the partial unique index on
   * payroll_entries is the hard backstop behind this check).
   */
  async accruePeriod(
    businessId: string,
    period: string,
    staffIds: string[] | undefined,
    account: IAccount | undefined,
    /** Set by the auto-accrual cron, which has no logged-in account to resolve. */
    actorOverride?: {id: string | null; name: string | null},
  ): Promise<{period: string; created: number; total: number}> {
    this.assertNotFuture(period);
    const {rows} = await this.previewPeriod(businessId, period);

    const selected = staffIds?.length
      ? rows.filter((r) => staffIds.includes(r.staffId))
      : rows;

    if (selected.length === 0) {
      throw new AppException(ErrorCode.PAYROLL_NOTHING_TO_ACCRUE, {period});
    }

    // Zero-value rows are skipped: posting a 0 accrual would occupy the
    // one-per-month slot and block a real accrual once the salary is set up.
    const pending = selected.filter((r) => !r.alreadyAccrued && r.total > 0);
    if (pending.length === 0) {
      throw new AppException(ErrorCode.PAYROLL_ALREADY_ACCRUED, {period});
    }

    const actor = actorOverride ?? (await this.resolveActor(businessId, account));

    try {
      await this.db.transaction(async (tx) => {
        for (const row of pending) {
          const balanceAfter = await this.applyToBalance(
            tx,
            row.staffId,
            row.total,
            1,
          );
          await tx.insert(payrollEntries).values({
            id: generateId(),
            businessId,
            staffId: row.staffId,
            staffName: row.staffName,
            type: 'accrual',
            amount: String(row.total),
            balanceAfter: String(balanceAfter),
            periodMonth: period,
            baseAmount: String(row.baseAmount),
            salesAmount: String(row.salesAmount),
            salesBase: String(row.salesBase),
            percentApplied: String(row.percentApplied),
            createdById: actor.id,
            createdByName: actor.name,
          });
        }
      });
    } catch (err) {
      // Two runs raced past the alreadyAccrued check (a double-clicked
      // confirm). The partial unique index rejected the loser — report it as
      // "already accrued" rather than leaking a 500. The whole transaction
      // rolled back, so no balance was moved.
      if ((err as {code?: string})?.code === '23505') {
        throw new AppException(ErrorCode.PAYROLL_ALREADY_ACCRUED, {period});
      }
      throw err;
    }

    return {
      period,
      created: pending.length,
      total: pending.reduce((sum, r) => sum + r.total, 0),
    };
  }

  // ─── Balance mutation ─────────────────────────────────────────────────────

  /**
   * Move an employee's running balance by `sign × amount` and return the new
   * value. The update is a single SQL expression (not read-modify-write) so
   * concurrent payments can't clobber each other's delta.
   */
  private async applyToBalance(
    tx: DbTx,
    staffId: string,
    amount: number,
    sign: 1 | -1,
  ): Promise<number> {
    const delta = sign * amount;
    const [updated] = await tx
      .update(staff)
      .set({
        salaryBalance: sql`${staff.salaryBalance} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(staff.id, staffId))
      .returning({balance: staff.salaryBalance});
    return Number(updated.balance);
  }

  /** Snapshot of who posted an entry (owner or staff). */
  private async resolveActor(
    businessId: string,
    account?: IAccount,
  ): Promise<{id: string | null; name: string | null}> {
    if (!account) return {id: null, name: null};
    if (account.type === 'staff') {
      const [row] = await this.db
        .select({name: staff.name})
        .from(staff)
        .where(eq(staff.id, account.id))
        .limit(1);
      return {id: account.id, name: row?.name ?? null};
    }
    const [row] = await this.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return {id: account.id, name: row?.name ?? null};
  }

  private async loadStaff(businessId: string, staffId: string) {
    const [member] = await this.db
      .select()
      .from(staff)
      .where(and(eq(staff.businessId, businessId), eq(staff.id, staffId)))
      .limit(1);
    if (!member) throw new AppException(ErrorCode.STAFF_NOT_FOUND);
    return member;
  }

  // ─── Payments & adjustments ───────────────────────────────────────────────

  /**
   * Pay an employee (or hand out an advance). Money actually moves: the entry
   * and the matching finance expense under "Ish haqi" are written in one
   * transaction, so the ledger and the cash account can never disagree.
   */
  async recordPayment(
    businessId: string,
    staffId: string,
    data: {
      amount: number;
      accountId: string;
      type: 'payment' | 'advance';
      note?: string;
    },
    account: IAccount | undefined,
  ): Promise<PayrollEntry> {
    if (!(data.amount > 0)) {
      throw new AppException(ErrorCode.PAYROLL_AMOUNT_INVALID);
    }
    const member = await this.loadStaff(businessId, staffId);
    const actor = await this.resolveActor(businessId, account);
    const category =
      await this.financeService.getOrCreatePayrollCategory(businessId);

    const label = data.type === 'advance' ? 'Avans' : 'Ish haqi';

    return this.db.transaction(async (tx) => {
      const txn = await this.financeService.recordExpenseTx(tx, businessId, {
        accountId: data.accountId,
        amount: data.amount,
        currency: 'UZS',
        categoryId: category.id,
        categoryName: category.name,
        cashierId: actor.id,
        cashierName: actor.name,
        note: data.note?.trim() || `${label} — ${member.name}`,
      });

      const balanceAfter = await this.applyToBalance(
        tx,
        staffId,
        data.amount,
        -1,
      );

      const [entry] = await tx
        .insert(payrollEntries)
        .values({
          id: generateId(),
          businessId,
          staffId,
          staffName: member.name,
          type: data.type,
          amount: String(data.amount),
          balanceAfter: String(balanceAfter),
          accountId: data.accountId,
          financialTransactionId: txn.id,
          note: data.note?.trim() || null,
          createdById: actor.id,
          createdByName: actor.name,
        })
        .returning();
      return entry;
    });
  }

  /**
   * A manual bonus (mukofot) or withholding (jarima). No money moves — these
   * only shift what is owed, and get settled by a later payment.
   */
  async recordAdjustment(
    businessId: string,
    staffId: string,
    data: {amount: number; type: 'bonus' | 'deduction'; note?: string},
    account: IAccount | undefined,
  ): Promise<PayrollEntry> {
    if (!(data.amount > 0)) {
      throw new AppException(ErrorCode.PAYROLL_AMOUNT_INVALID);
    }
    const member = await this.loadStaff(businessId, staffId);
    const actor = await this.resolveActor(businessId, account);
    const sign = signOf(data.type);

    return this.db.transaction(async (tx) => {
      const balanceAfter = await this.applyToBalance(
        tx,
        staffId,
        data.amount,
        sign,
      );
      const [entry] = await tx
        .insert(payrollEntries)
        .values({
          id: generateId(),
          businessId,
          staffId,
          staffName: member.name,
          type: data.type,
          amount: String(data.amount),
          balanceAfter: String(balanceAfter),
          note: data.note?.trim() || null,
          createdById: actor.id,
          createdByName: actor.name,
        })
        .returning();
      return entry;
    });
  }

  /**
   * Undo an entry. The balance is reversed, and a payment's finance expense is
   * reversed too — as a compensating income row rather than a delete, so the
   * ledger keeps an audit trail of the correction.
   */
  async removeEntry(
    businessId: string,
    entryId: string,
    account: IAccount | undefined,
  ): Promise<void> {
    const [entry] = await this.db
      .select()
      .from(payrollEntries)
      .where(
        and(
          eq(payrollEntries.businessId, businessId),
          eq(payrollEntries.id, entryId),
        ),
      )
      .limit(1);
    if (!entry) throw new AppException(ErrorCode.PAYROLL_ENTRY_NOT_FOUND);

    const actor = await this.resolveActor(businessId, account);
    const amount = Number(entry.amount);
    // Reversing means applying the opposite sign of the original.
    const reverseSign = signOf(entry.type as PayrollEntryType) === 1 ? -1 : 1;

    await this.db.transaction(async (tx) => {
      await this.applyToBalance(tx, entry.staffId, amount, reverseSign);

      if (entry.financialTransactionId && entry.accountId) {
        const category =
          await this.financeService.getOrCreatePayrollCategory(businessId);
        await this.financeService.recordIncomeTx(tx, businessId, {
          accountId: entry.accountId,
          amount,
          currency: 'UZS',
          categoryId: category.id,
          categoryName: category.name,
          cashierId: actor.id,
          cashierName: actor.name,
          note: `Bekor qilindi: ${entry.staffName} — ish haqi to'lovi`,
        });
      }

      await tx.delete(payrollEntries).where(eq(payrollEntries.id, entryId));
    });
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * One row per employee: salary setup, running balance, and what they earned
   * and were paid in `period`. Backs the main payroll table.
   */
  async getSummary(businessId: string, period?: string) {
    const targetPeriod = period ?? this.currentPeriod();
    const {start, end} = this.monthRange(targetPeriod);

    const [members, sales, periodEntries, unaccrued] = await Promise.all([
      this.db
        .select()
        .from(staff)
        .leftJoin(branches, eq(staff.branchId, branches.id))
        .where(eq(staff.businessId, businessId))
        .orderBy(asc(staff.name)),
      this.personalSales(businessId, targetPeriod),
      // Accrual rows are matched by their period LABEL, every other type by the
      // month it was posted in. July's wage accrued on August 1st still belongs
      // to July — matching it by created_at would leave July reading "0
      // accrued" while August double-counted it. Money rows keep the cash-basis
      // reading an owner expects: an August payment against July's wage is
      // August's spend.
      this.db
        .select({
          staffId: payrollEntries.staffId,
          type: payrollEntries.type,
          amount: payrollEntries.amount,
        })
        .from(payrollEntries)
        .where(
          and(
            eq(payrollEntries.businessId, businessId),
            or(
              and(
                eq(payrollEntries.type, 'accrual'),
                eq(payrollEntries.periodMonth, targetPeriod),
              ),
              and(
                ne(payrollEntries.type, 'accrual'),
                gte(payrollEntries.createdAt, start),
                lt(payrollEntries.createdAt, end),
              ),
            ),
          ),
        ),
      this.unaccruedPeriods(businessId),
    ]);

    const accruedByStaff = new Map<string, number>();
    const paidByStaff = new Map<string, number>();
    // Whether the monthly accrual itself has been posted — distinct from
    // "accrued > 0", since a lone bonus also lands in the accrued bucket.
    const accrualPosted = new Set<string>();
    for (const e of periodEntries) {
      if (e.type === 'accrual') accrualPosted.add(e.staffId);
      const target =
        e.type === 'accrual' || e.type === 'bonus'
          ? accruedByStaff
          : e.type === 'payment' || e.type === 'advance'
            ? paidByStaff
            : null;
      if (!target) continue;
      target.set(e.staffId, (target.get(e.staffId) ?? 0) + Number(e.amount));
    }

    const rows = members.map(({staff: m, branches: branch}) => {
      const personal = sales.get(m.id) ?? {revenue: 0, cogs: 0};
      return {
        id: m.id,
        name: m.name,
        position: m.position,
        phone: m.phone,
        branchId: m.branchId,
        branchName: branch?.name ?? null,
        hasAccount: m.hasAccount,
        isActive: m.isActive,
        salaryType: m.salaryType,
        baseSalary: Number(m.baseSalary),
        salesPercent: Number(m.salesPercent),
        percentBase: m.percentBase,
        balance: Number(m.salaryBalance),
        periodRevenue: personal.revenue,
        periodProfit: personal.revenue - personal.cogs,
        periodAccrued: accruedByStaff.get(m.id) ?? 0,
        periodPaid: paidByStaff.get(m.id) ?? 0,
        // Drives the "hisoblanmagan" marker: on payroll, but this month's
        // accrual was never run. Without it a paid-but-unaccrued employee
        // reads as overpaid, which is what the balance literally says and
        // not at all what happened.
        accrualPosted: accrualPosted.has(m.id),
      };
    });

    return {
      period: targetPeriod,
      rows,
      // Closed months with no accrual at all, newest first. Independent of the
      // selected period: the balance is a lifetime figure, so the explanation
      // for a surprising one has to be visible from any month.
      unaccruedPeriods: unaccrued,
      totals: {
        // Everyone counts toward the liability — someone taken off payroll
        // still carrying a balance is still owed (or still owes).
        balance: rows.reduce((s, r) => s + r.balance, 0),
        accrued: rows.reduce((s, r) => s + r.periodAccrued, 0),
        paid: rows.reduce((s, r) => s + r.periodPaid, 0),
        onPayroll: rows.filter((r) => r.salaryType !== 'none').length,
        // How many on-payroll employees are still missing this month's accrual.
        pendingAccrual: rows.filter(
          (r) => r.salaryType !== 'none' && !r.accrualPosted,
        ).length,
      },
    };
  }

  /** Ledger history for one employee, newest first. */
  async getEntries(
    businessId: string,
    staffId: string,
    limit = 100,
  ): Promise<PayrollEntry[]> {
    await this.loadStaff(businessId, staffId);
    return this.db
      .select()
      .from(payrollEntries)
      .where(
        and(
          eq(payrollEntries.businessId, businessId),
          eq(payrollEntries.staffId, staffId),
        ),
      )
      .orderBy(desc(payrollEntries.createdAt))
      .limit(Math.min(limit, 500));
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  /** Payroll preferences, falling back to defaults when never saved. */
  async getSettings(businessId: string): Promise<PayrollSettings> {
    const [row] = await this.db
      .select()
      .from(payrollSettings)
      .where(eq(payrollSettings.businessId, businessId))
      .limit(1);
    return (
      row ?? {
        businessId,
        autoAccrue: false,
        lastAutoPeriod: null,
        updatedAt: new Date(),
      }
    );
  }

  async updateSettings(
    businessId: string,
    dto: {autoAccrue: boolean},
  ): Promise<PayrollSettings> {
    await this.db
      .insert(payrollSettings)
      .values({
        businessId,
        autoAccrue: dto.autoAccrue,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: payrollSettings.businessId,
        // lastAutoPeriod is deliberately untouched: flipping the switch off and
        // on again must not make the cron re-post a month it already handled.
        set: {autoAccrue: dto.autoAccrue, updatedAt: new Date()},
      });
    return this.getSettings(businessId);
  }

  // ─── Auto-accrual ─────────────────────────────────────────────────────────

  /** 'YYYY-MM' `back` months before `period` (default: the month before). */
  private previousPeriod(period: string, back = 1): string {
    const [year, month] = period.split('-').map(Number);
    const total = year * 12 + (month - 1) - back;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  }

  /**
   * Closed months that were never accrued — the reason a balance can read as
   * an "overpayment" when the employee was simply paid before the month was
   * posted. Scanned from when payroll was first configured (capped at 12
   * months) up to the last closed month; the current month is excluded because
   * it is not finished yet.
   *
   * A month counts as accrued if it has ANY accrual row: a partially-run month
   * is not worth nagging about, and the preview modal shows who is left.
   */
  private async unaccruedPeriods(businessId: string): Promise<string[]> {
    const lastClosed = this.previousPeriod(this.currentPeriod());
    const floor = this.previousPeriod(this.currentPeriod(), 12);

    const [[earliest], accruedRows] = await Promise.all([
      this.db
        .select({first: sql<string | null>`MIN(${staff.createdAt})`})
        .from(staff)
        .where(
          and(
            eq(staff.businessId, businessId),
            sql`${staff.salaryType} <> 'none'`,
          ),
        ),
      this.db
        .selectDistinct({period: payrollEntries.periodMonth})
        .from(payrollEntries)
        .where(
          and(
            eq(payrollEntries.businessId, businessId),
            eq(payrollEntries.type, 'accrual'),
          ),
        ),
    ]);

    // Nobody on payroll → nothing was ever owed, so nothing is missing.
    if (!earliest?.first) return [];
    // Business zone, not UTC: someone hired at 00:30 on the 1st must not make
    // the previous month look like a month we forgot to pay.
    const start = new Date(
      new Date(earliest.first).getTime() + 5 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 7);

    const accrued = new Set(accruedRows.map((r) => r.period));
    const from = start > floor ? start : floor;

    const missing: string[] = [];
    for (let p = lastClosed; p >= from; p = this.previousPeriod(p)) {
      if (!accrued.has(p)) missing.push(p);
    }
    return missing;
  }

  /**
   * 03:00 on the 1st, Asia/Tashkent: post the previous month's accrual for
   * every business that opted in. Runs after the month has closed so percent-
   * and profit-based wages are computed on final numbers, not a partial month.
   *
   * Safe to fire more than once: `lastAutoPeriod` short-circuits the common
   * case and the partial unique index on payroll_entries is the hard backstop,
   * so a manual run by the owner simply wins.
   */
  @Cron('0 3 1 * *', {name: 'payroll-auto-accrue', timeZone: 'Asia/Tashkent'})
  async runAutoAccruals(): Promise<void> {
    if (process.env.PAYROLL_AUTO_ACCRUE === 'off') return;
    const period = this.previousPeriod(this.currentPeriod());

    const optedIn = await this.db
      .select({
        businessId: payrollSettings.businessId,
        name: businesses.name,
        lastAutoPeriod: payrollSettings.lastAutoPeriod,
      })
      .from(payrollSettings)
      .innerJoin(businesses, eq(payrollSettings.businessId, businesses.id))
      .where(
        and(
          eq(payrollSettings.autoAccrue, true),
          eq(businesses.isActive, true),
        ),
      );

    let accrued = 0;
    for (const biz of optedIn) {
      if (biz.lastAutoPeriod === period) continue;
      try {
        const res = await this.accruePeriod(
          biz.businessId,
          period,
          undefined,
          undefined,
          {id: null, name: 'Avtomatik'},
        );
        accrued += 1;
        this.logger.log(
          `Auto-accrued ${period} for ${biz.name}: ${res.created} employees, ${res.total}`,
        );
      } catch (e) {
        // Nothing to accrue and already-accrued are ordinary outcomes, not
        // failures — the period is still handled, so don't retry next month.
        const code = (e as AppException)?.code;
        const expected =
          code === ErrorCode.PAYROLL_NOTHING_TO_ACCRUE ||
          code === ErrorCode.PAYROLL_ALREADY_ACCRUED;
        if (!expected) {
          this.logger.error(
            `Auto-accrual failed for ${biz.name} (${biz.businessId}): ${(e as Error).message}`,
          );
          continue; // leave lastAutoPeriod alone so a manual run is still expected
        }
      }
      await this.db
        .update(payrollSettings)
        .set({lastAutoPeriod: period})
        .where(eq(payrollSettings.businessId, biz.businessId));
    }

    this.logger.log(
      `Payroll auto-accrual for ${period}: ${accrued}/${optedIn.length} businesses posted.`,
    );
  }
}
