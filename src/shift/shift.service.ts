import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {isStockTakeActive} from '../common/stock-take-lock';
import {BranchService} from '../branch/branch.service';
import {CacheKeys, TTL} from '../cache/cache.util';
import {DatabaseService} from '../database/database.service';
import {TelegramNotifyService} from '../telegram/telegram-notify.service';
import {
  cashRegisters,
  cashShifts,
  cashMovements,
  financialCategories,
  orders,
  saleReturns,
  staff,
  businesses,
  suppliers,
  type CashRegister,
  type CashShift,
  type CashMovement,
} from '../database/schema';
import {
  eq,
  and,
  desc,
  ne,
  gte,
  lte,
  or,
  ilike,
  isNull,
  isNotNull,
  sql,
  getTableColumns,
  type SQL,
} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {businessDayStart, businessDayEnd} from '../common/business-time';
import {IAccount} from '../business/types';
import {FinanceService} from '../finance/finance.service';
import {ReceiptService} from '../receipt/receipt.service';
import {OpenShiftDto} from './dto/open-shift.dto';
import {CreateCashMovementDto} from './dto/create-cash-movement.dto';
import {PaySupplierDto} from './dto/pay-supplier.dto';
import {QueryCashMovementsDto} from './dto/query-cash-movements.dto';
import {CloseShiftDto} from './dto/close-shift.dto';
import {
  computeReconciliation,
  type ReconRow,
  type SaleTotals,
} from './reconciliation';

/** Category shape the kassa UI still expects (direction, not kind). */
export interface CashCategoryCompat {
  id: string;
  businessId: string;
  name: string;
  direction: 'in' | 'out';
  isActive: boolean;
  createdAt: Date;
}

export type {ReconRow};

export interface ShiftReport {
  shift: CashShift;
  movements: CashMovement[];
  reconciliation: ReconRow[];
  orderCount: number;
}

// Default register created for a business the first time it touches the kassa
// module, so existing businesses keep working without a data migration.
// (Operation categories now live in the shared finance categories table.)
const DEFAULT_REGISTER_NAME = 'Asosiy kassa';

// Category name snapshotted onto a till payment to a supplier. It is not a
// finance category: the money is booked as supplier payments, not an expense.
const TILL_SUPPLIER_PAYMENT = "Ta'minotchiga to'lov";

@Injectable()
export class ShiftService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly financeService: FinanceService,
    private readonly receiptService: ReceiptService,
    private readonly branchService: BranchService,
    private readonly telegramNotify: TelegramNotifyService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ─── Acting cashier (owner or staff) ──────────────────────────────────────
  private async resolveCashier(
    account?: IAccount,
  ): Promise<{id: string | null; name: string | null}> {
    if (!account) return {id: null, name: null};
    if (account.type === 'staff') {
      const [row] = await this.dbService.db
        .select({name: staff.name})
        .from(staff)
        .where(eq(staff.id, account.id))
        .limit(1);
      return {id: account.id, name: row?.name ?? null};
    }
    const [row] = await this.dbService.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, account.id))
      .limit(1);
    return {id: account.id, name: row?.name ?? null};
  }

  // ─── Lazy defaults ────────────────────────────────────────────────────────
  // Create a single default register the first time the business touches the
  // kassa module. Also self-heals duplicate auto-created defaults that a race
  // (two concurrent GETs) may have produced, deactivating unused extras.
  private async ensureDefaultRegister(businessId: string): Promise<void> {
    const regs = await this.dbService.db
      .select({
        id: cashRegisters.id,
        name: cashRegisters.name,
        createdAt: cashRegisters.createdAt,
      })
      .from(cashRegisters)
      .where(
        and(
          eq(cashRegisters.businessId, businessId),
          eq(cashRegisters.isActive, true),
        ),
      )
      .orderBy(cashRegisters.createdAt);

    if (regs.length === 0) {
      const branchId = (await this.branchService.ensureDefault(businessId)).id;
      await this.dbService.db.insert(cashRegisters).values({
        id: generateId(),
        businessId,
        name: DEFAULT_REGISTER_NAME,
        branchId,
        isActive: true,
      });
      return;
    }

    // Collapse duplicate auto-created defaults (same name), keeping the oldest.
    // Only deactivate extras that have no shifts, so real data is never touched.
    const dupes = regs.filter((r) => r.name === DEFAULT_REGISTER_NAME).slice(1);
    for (const d of dupes) {
      const used = await this.dbService.db
        .select({id: cashShifts.id})
        .from(cashShifts)
        .where(eq(cashShifts.registerId, d.id))
        .limit(1);
      if (used.length === 0) {
        await this.dbService.db
          .update(cashRegisters)
          .set({isActive: false, updatedAt: new Date()})
          .where(eq(cashRegisters.id, d.id));
      }
    }
  }

  // ─── Registers (kassa) ────────────────────────────────────────────────────
  async getRegisters(businessId: string): Promise<CashRegister[]> {
    await this.ensureDefaultRegister(businessId);
    return this.dbService.db
      .select()
      .from(cashRegisters)
      .where(
        and(
          eq(cashRegisters.businessId, businessId),
          eq(cashRegisters.isActive, true),
        ),
      )
      .orderBy(desc(cashRegisters.createdAt));
  }

  async createRegister(
    businessId: string,
    data: {name: string; storeId?: string; branchId?: string},
  ): Promise<CashRegister> {
    // A register sells from one branch; default to the business default branch.
    const branchId =
      data.branchId ?? (await this.branchService.ensureDefault(businessId)).id;
    const [register] = await this.dbService.db
      .insert(cashRegisters)
      .values({
        id: generateId(),
        businessId,
        name: data.name,
        storeId: data.storeId ?? null,
        branchId,
        isActive: true,
      })
      .returning();
    return register;
  }

  async updateRegister(
    businessId: string,
    registerId: string,
    data: {name?: string; isActive?: boolean; branchId?: string},
  ): Promise<CashRegister> {
    const [existing] = await this.dbService.db
      .select()
      .from(cashRegisters)
      .where(
        and(
          eq(cashRegisters.id, registerId),
          eq(cashRegisters.businessId, businessId),
        ),
      )
      .limit(1);
    if (!existing) throw new AppException(ErrorCode.REGISTER_NOT_FOUND);

    const [register] = await this.dbService.db
      .update(cashRegisters)
      .set({...data, updatedAt: new Date()})
      .where(
        and(
          eq(cashRegisters.id, registerId),
          eq(cashRegisters.businessId, businessId),
        ),
      )
      .returning();
    return register;
  }

  // ─── Cash operation categories (Toifa) ────────────────────────────────────
  // Now backed by the shared finance categories table (single source of truth).
  // The kassa UI still speaks `direction` (in/out); we map it to finance `kind`
  // (income/expense): in↔income, out↔expense.
  async getCashCategories(businessId: string): Promise<CashCategoryCompat[]> {
    return this.financeService.getCategoriesAsDirection(businessId);
  }

  async createCashCategory(
    businessId: string,
    data: {name: string; direction?: 'in' | 'out' | 'both'},
  ): Promise<CashCategoryCompat> {
    // 'in' → income; 'out'/'both' → expense (income is the exception).
    const kind = data.direction === 'in' ? 'income' : 'expense';
    const category = await this.financeService.createCategory(businessId, {
      name: data.name,
      kind,
    });
    return {
      id: category.id,
      businessId: category.businessId,
      name: category.name,
      direction: kind === 'income' ? 'in' : 'out',
      isActive: category.isActive,
      createdAt: category.createdAt,
    };
  }

  async updateCashCategory(
    businessId: string,
    categoryId: string,
    data: {
      name?: string;
      direction?: 'in' | 'out' | 'both';
      isActive?: boolean;
    },
  ): Promise<CashCategoryCompat> {
    const category = await this.financeService.updateCategory(
      businessId,
      categoryId,
      {name: data.name, isActive: data.isActive},
    );
    return {
      id: category.id,
      businessId: category.businessId,
      name: category.name,
      direction: category.kind === 'income' ? 'in' : 'out',
      isActive: category.isActive,
      createdAt: category.createdAt,
    };
  }

  // ─── Shifts ───────────────────────────────────────────────────────────────

  /** The open shift for a specific register, or null. */
  async getCurrentShift(
    businessId: string,
    registerId: string,
  ): Promise<CashShift | null> {
    const [shift] = await this.dbService.db
      .select()
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.businessId, businessId),
          eq(cashShifts.registerId, registerId),
          eq(cashShifts.status, 'open'),
        ),
      )
      .limit(1);
    return shift ?? null;
  }

  /** All currently open shifts for the business (one per register at most). Each
   *  carries the branch its register sells from, so the till knows which store's
   *  stock to show/deplete. */
  async getOpenShifts(
    businessId: string,
  ): Promise<(CashShift & {branchId: string | null})[]> {
    // Cache-aside: this is polled on every checkout mount/focus (refreshShift).
    // A cashShift row only changes on open/close, both of which del this key, so
    // the cached list stays correct; the TTL is just a safety refresh.
    return this.cache.wrap(
      CacheKeys.openShifts(businessId),
      () =>
        this.dbService.db
          .select({
            ...getTableColumns(cashShifts),
            branchId: cashRegisters.branchId,
          })
          .from(cashShifts)
          .leftJoin(cashRegisters, eq(cashShifts.registerId, cashRegisters.id))
          .where(
            and(
              eq(cashShifts.businessId, businessId),
              eq(cashShifts.status, 'open'),
            ),
          )
          .orderBy(desc(cashShifts.openedAt)),
      TTL.OPEN_SHIFTS,
    );
  }

  /** Drop the cached open-shift list after a shift opens or closes. */
  private async invalidateOpenShifts(businessId: string): Promise<void> {
    await this.cache.del(CacheKeys.openShifts(businessId));
  }

  /**
   * Open shifts + whether a stock-take is freezing the till, in one round-trip.
   * The checkout polls this on load/focus, so folding the freeze flag in here
   * lets the client drop its separate `stock-takes` request. The shift list is
   * cached (invalidated on open/close); the freeze flag comes from its own
   * cache (fresh — set on count start, cleared on completion/cancel).
   */
  async getOpenShiftsWithFreeze(businessId: string): Promise<{
    shifts: (CashShift & {branchId: string | null})[];
    stockTakeActive: boolean;
  }> {
    const [shifts, stockTakeActive] = await Promise.all([
      this.getOpenShifts(businessId),
      isStockTakeActive(this.cache, this.dbService.db, businessId),
    ]);
    return {shifts, stockTakeActive};
  }

  // Blocks opening a shift while an inventory count is in progress. Cache-aside
  // read (in-memory flag, DB as source of truth), mirrors OrderService; fail-open
  // if the stock_takes table isn't migrated yet.
  private async assertNoStockTakeInProgress(businessId: string): Promise<void> {
    if (await isStockTakeActive(this.cache, this.dbService.db, businessId)) {
      throw new AppException(ErrorCode.REGISTER_OPEN_FROZEN_STOCK_TAKE);
    }
  }

  async openShift(
    businessId: string,
    dto: OpenShiftDto,
    account?: IAccount,
  ): Promise<CashShift> {
    // Freeze the register while a stock-take is open (INVENTARIZATSIYA.md §9.4).
    await this.assertNoStockTakeInProgress(businessId);

    // Register must exist and belong to the business.
    const [register] = await this.dbService.db
      .select()
      .from(cashRegisters)
      .where(
        and(
          eq(cashRegisters.id, dto.registerId),
          eq(cashRegisters.businessId, businessId),
          eq(cashRegisters.isActive, true),
        ),
      )
      .limit(1);
    if (!register) throw new AppException(ErrorCode.REGISTER_NOT_FOUND);

    // One open shift per register.
    const current = await this.getCurrentShift(businessId, dto.registerId);
    if (current) {
      throw new AppException(ErrorCode.REGISTER_ALREADY_OPEN);
    }

    const cashier = await this.resolveCashier(account);
    const [shift] = await this.dbService.db
      .insert(cashShifts)
      .values({
        id: generateId(),
        businessId,
        registerId: register.id,
        registerName: register.name,
        status: 'open',
        openingFloat: String(dto.openingFloat ?? 0),
        openedByCashierId: cashier.id,
        openedByCashierName: cashier.name,
        note: dto.note ?? null,
      })
      .returning();
    await this.invalidateOpenShifts(businessId);
    this.telegramNotify.notifyShiftOpened(businessId, shift);
    return shift;
  }

  /** A single shift (with its movements) for the business. */
  async getShift(businessId: string, shiftId: string): Promise<CashShift> {
    const [shift] = await this.dbService.db
      .select()
      .from(cashShifts)
      .where(
        and(eq(cashShifts.id, shiftId), eq(cashShifts.businessId, businessId)),
      )
      .limit(1);
    if (!shift) throw new AppException(ErrorCode.SHIFT_NOT_FOUND);
    return shift;
  }

  /** Paginated shift history for the business. */
  async getShifts(
    businessId: string,
    options?: {page?: number; limit?: number; registerId?: string},
  ): Promise<{
    shifts: CashShift[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;

    const where = [eq(cashShifts.businessId, businessId)];
    if (options?.registerId) {
      where.push(eq(cashShifts.registerId, options.registerId));
    }

    const all = await this.dbService.db
      .select({id: cashShifts.id})
      .from(cashShifts)
      .where(and(...where));

    const shifts = await this.dbService.db
      .select()
      .from(cashShifts)
      .where(and(...where))
      .orderBy(desc(cashShifts.openedAt))
      .limit(limit)
      .offset(offset);

    return {shifts, total: all.length, page, limit};
  }

  // ─── Cash movements (kirim/chiqim) ────────────────────────────────────────

  /** Load an OPEN shift for the business, or throw. */
  private async loadOpenShift(
    businessId: string,
    shiftId: string,
  ): Promise<CashShift> {
    const shift = await this.getShift(businessId, shiftId);
    if (shift.status !== 'open') {
      throw new AppException(ErrorCode.SHIFT_ALREADY_CLOSED);
    }
    return shift;
  }

  async addMovement(
    businessId: string,
    shiftId: string,
    dto: CreateCashMovementDto,
    account?: IAccount,
  ): Promise<CashMovement> {
    const shift = await this.loadOpenShift(businessId, shiftId);

    // Resolve the category (name snapshot) if one was given.
    let categoryName: string | null = null;
    if (dto.categoryId) {
      const [cat] = await this.dbService.db
        .select()
        .from(financialCategories)
        .where(
          and(
            eq(financialCategories.id, dto.categoryId),
            eq(financialCategories.businessId, businessId),
          ),
        )
        .limit(1);
      if (!cat) throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);
      categoryName = cat.name;
    }

    const cashier = await this.resolveCashier(account);
    const isCash = dto.isCash ?? true;
    const currency = dto.currency ?? 'UZS';

    // Insert the movement and mirror it into the finance ledger + balance in one
    // atomic transaction, so the two never drift apart.
    const movement = await this.dbService.db.transaction(async (tx) => {
      const [movement] = await tx
        .insert(cashMovements)
        .values({
          id: generateId(),
          businessId,
          shiftId: shift.id,
          registerId: shift.registerId,
          type: dto.type,
          isCash,
          amount: String(dto.amount),
          currency,
          categoryId: dto.categoryId ?? null,
          categoryName,
          reason: dto.reason ?? null,
          cashierId: cashier.id,
          cashierName: cashier.name,
        })
        .returning();

      await this.financeService.recordCashMovementTx(
        tx,
        businessId,
        {
          id: movement.id,
          shiftId: movement.shiftId,
          registerId: movement.registerId,
          type: movement.type,
          isCash: movement.isCash,
          amount: movement.amount,
          currency: movement.currency,
          categoryId: movement.categoryId,
          categoryName: movement.categoryName,
          cashierId: movement.cashierId,
          cashierName: movement.cashierName,
        },
        {id: shift.registerId, name: shift.registerName},
      );

      return movement;
    });
    // Post-commit, fire-and-forget: notify the linked chats of the cash in/out.
    this.telegramNotify.notifyCashOperation(businessId, movement);
    return movement;
  }

  /**
   * "Ta'minotchiga to'lov": till money handed to a supplier.
   *
   * The drawer sees an ordinary cash-out movement, so the shift's count still
   * reconciles. The money is NOT mirrored as an expense the way addMovement
   * does it: ReceiptService settles the supplier's open receipts with it,
   * oldest first, and keeps the rest as their advance. Cash movement, supplier
   * payments, receipts and advance commit together or not at all.
   */
  async paySupplier(
    businessId: string,
    shiftId: string,
    dto: PaySupplierDto,
    account?: IAccount,
  ) {
    const shift = await this.loadOpenShift(businessId, shiftId);
    const cashier = await this.resolveCashier(account);
    const isCash = dto.isCash ?? true;
    const currency = dto.currency ?? 'UZS';
    const reason = dto.reason?.trim() || null;

    const result = await this.dbService.db.transaction(async (tx) => {
      // Read, not locked: the receipts are locked before the supplier row —
      // the order every credit write keeps — and payFromTillTx takes both.
      const [supplier] = await tx
        .select({id: suppliers.id, name: suppliers.name})
        .from(suppliers)
        .where(
          and(
            eq(suppliers.id, dto.supplierId),
            eq(suppliers.businessId, businessId),
          ),
        )
        .limit(1);
      if (!supplier) throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);

      const [movement] = await tx
        .insert(cashMovements)
        .values({
          id: generateId(),
          businessId,
          shiftId: shift.id,
          registerId: shift.registerId,
          type: 'out',
          isCash,
          amount: String(dto.amount),
          currency,
          categoryId: null,
          categoryName: TILL_SUPPLIER_PAYMENT,
          reason,
          cashierId: cashier.id,
          cashierName: cashier.name,
          supplierId: supplier.id,
          supplierName: supplier.name,
        })
        .returning();

      const settled = await this.receiptService.payFromTillTx(tx, businessId, {
        supplierId: supplier.id,
        supplierName: supplier.name,
        amount: dto.amount,
        reason,
        movement: {
          id: movement.id,
          shiftId: movement.shiftId,
          isCash: movement.isCash,
          currency: movement.currency,
          cashierId: movement.cashierId,
          cashierName: movement.cashierName,
        },
        register: {id: shift.registerId, name: shift.registerName},
      });

      return {movement, ...settled};
    });

    this.telegramNotify.notifyCashOperation(businessId, result.movement);
    return result;
  }

  /** The supplier's open debt and advance, for the till's payment form. */
  async supplierDebt(businessId: string, supplierId: string, currency: string) {
    return this.receiptService.tillDebt(businessId, supplierId, currency);
  }

  async getShiftMovements(
    businessId: string,
    shiftId: string,
  ): Promise<CashMovement[]> {
    return this.dbService.db
      .select()
      .from(cashMovements)
      .where(
        and(
          eq(cashMovements.businessId, businessId),
          eq(cashMovements.shiftId, shiftId),
        ),
      )
      .orderBy(desc(cashMovements.createdAt));
  }

  /**
   * Kassa operatsiyalari: the till's kirim/chiqim across shifts, newest
   * first, filtered — with the totals of everything that matches (not just
   * the page), per direction × method × currency, never summed across
   * currencies. `cashiers` lists everyone who ever recorded one, for the
   * filter. Sales are not here: they live on the shift report.
   */
  async listMovements(businessId: string, query: QueryCashMovementsDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));

    const where: SQL[] = [eq(cashMovements.businessId, businessId)];
    if (query.from) {
      where.push(gte(cashMovements.createdAt, businessDayStart(query.from)));
    }
    if (query.to) {
      where.push(lte(cashMovements.createdAt, businessDayEnd(query.to)));
    }
    if (query.shiftId) where.push(eq(cashMovements.shiftId, query.shiftId));
    if (query.registerId) {
      where.push(eq(cashMovements.registerId, query.registerId));
    }
    if (query.type) where.push(eq(cashMovements.type, query.type));
    if (query.method) {
      where.push(eq(cashMovements.isCash, query.method === 'cash'));
    }
    if (query.currency) where.push(eq(cashMovements.currency, query.currency));
    if (query.categoryId === 'supplier') {
      where.push(isNotNull(cashMovements.supplierId));
    } else if (query.categoryId === 'none') {
      where.push(
        isNull(cashMovements.categoryId),
        isNull(cashMovements.supplierId),
      );
    } else if (query.categoryId) {
      where.push(eq(cashMovements.categoryId, query.categoryId));
    }
    if (query.supplierId) {
      where.push(eq(cashMovements.supplierId, query.supplierId));
    }
    if (query.cashierId) {
      where.push(eq(cashMovements.cashierId, query.cashierId));
    }
    const search = query.search?.trim();
    if (search) {
      // Typed text is matched literally: % and _ are not wildcards here.
      const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(
          ilike(cashMovements.reason, like),
          ilike(cashMovements.categoryName, like),
          ilike(cashMovements.supplierName, like),
          ilike(cashMovements.cashierName, like),
        )!,
      );
    }
    const filter = and(...where);
    const db = this.dbService.db;

    const [movements, [{total}], summary, cashiers] = await Promise.all([
      db
        .select({
          ...getTableColumns(cashMovements),
          registerName: cashRegisters.name,
        })
        .from(cashMovements)
        .leftJoin(cashRegisters, eq(cashRegisters.id, cashMovements.registerId))
        .where(filter)
        .orderBy(desc(cashMovements.createdAt), desc(cashMovements.id))
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({total: sql<number>`count(*)::int`})
        .from(cashMovements)
        .where(filter),
      db
        .select({
          type: cashMovements.type,
          isCash: cashMovements.isCash,
          currency: cashMovements.currency,
          count: sql<number>`count(*)::int`,
          amount: sql<string>`sum(${cashMovements.amount})`,
        })
        .from(cashMovements)
        .where(filter)
        .groupBy(
          cashMovements.type,
          cashMovements.isCash,
          cashMovements.currency,
        ),
      db
        .selectDistinct({
          id: cashMovements.cashierId,
          name: cashMovements.cashierName,
        })
        .from(cashMovements)
        .where(
          and(
            eq(cashMovements.businessId, businessId),
            isNotNull(cashMovements.cashierId),
          ),
        ),
    ]);

    return {
      movements,
      total,
      page,
      limit,
      summary: summary.map((r) => ({...r, amount: Number(r.amount)})),
      // One entry per person, even if their name was spelled differently
      // over time.
      cashiers: Array.from(
        new Map(
          cashiers
            .filter((c): c is {id: string; name: string | null} => !!c.id)
            .map((c) => [c.id, {id: c.id, name: c.name ?? '—'}]),
        ).values(),
      ).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // ─── Reconciliation (X / Z report) ────────────────────────────────────────

  /**
   * Build the per-method × per-currency reconciliation grid for a shift from its
   * sales (orders) and manual movements. `counted` (from close) fills the
   * Haqiqatda/Farq columns; for an X-report it's left null.
   */
  private async buildReconciliation(
    shift: CashShift,
    movements: CashMovement[],
    counted?: Map<string, number>,
  ): Promise<{
    rows: ReconRow[];
    orderCount: number;
    hasUsd: boolean;
    saleTotals: SaleTotals;
  }> {
    // Sales for this shift (exclude cancelled).
    const shiftOrders = await this.dbService.db
      .select({
        totalAmount: orders.totalAmount,
        payments: orders.payments,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, shift.businessId),
          eq(orders.shiftId, shift.id),
          ne(orders.status, 'Cancelled'),
        ),
      );

    // Refunds paid out of this shift by customer returns.
    const shiftReturns = await this.dbService.db
      .select({
        refunds: saleReturns.refunds,
        debtReduced: saleReturns.debtReduced,
      })
      .from(saleReturns)
      .where(
        and(
          eq(saleReturns.businessId, shift.businessId),
          eq(saleReturns.shiftId, shift.id),
        ),
      );

    // Pure math lives in ./reconciliation (unit-tested there).
    return computeReconciliation({
      returns: shiftReturns.map((r) => ({
        refunds: r.refunds as {method: string; amount: number}[] | null,
        debtReduced: r.debtReduced,
      })),
      openingFloat: Number(shift.openingFloat ?? 0),
      sales: shiftOrders.map((o) => ({
        totalAmount: o.totalAmount,
        payments: o.payments as {method: string; amount: number}[] | null,
      })),
      movements: movements.map((m) => ({
        isCash: m.isCash,
        currency: m.currency,
        type: m.type,
        amount: m.amount,
      })),
      counted,
    });
  }

  /** X-report: live reconciliation without closing the shift. */
  async getShiftReport(
    businessId: string,
    shiftId: string,
  ): Promise<ShiftReport> {
    const shift = await this.getShift(businessId, shiftId);
    const movements = await this.getShiftMovements(businessId, shiftId);
    const {rows, orderCount} = await this.buildReconciliation(shift, movements);
    return {shift, movements, reconciliation: rows, orderCount};
  }

  /** Close a shift: compute the Z-report and persist it in one transaction. */
  async closeShift(
    businessId: string,
    shiftId: string,
    dto: CloseShiftDto,
    account?: IAccount,
  ): Promise<CashShift> {
    const shift = await this.loadOpenShift(businessId, shiftId);

    // Permission: the owner may close any shift; staff may close only their own.
    // (A future "manager" role permission can widen this.)
    if (
      account?.type === 'staff' &&
      shift.openedByCashierId &&
      shift.openedByCashierId !== account.id
    ) {
      throw new AppException(ErrorCode.SHIFT_CLOSE_FORBIDDEN);
    }

    const counted = new Map<string, number>();
    for (const c of dto.counted ?? []) {
      counted.set(`${c.method}:${c.currency}`, c.amount);
    }

    const movements = await this.getShiftMovements(businessId, shiftId);
    const {rows, orderCount, saleTotals} = await this.buildReconciliation(
      shift,
      movements,
      counted,
    );

    // Scalar UZS-cash summary (the row stores den-per-normalised).
    const cashRow = rows.find(
      (r) => r.method === 'cash' && r.currency === 'UZS',
    )!;
    const cashier = await this.resolveCashier(account);

    // Persist the Z-report and mirror the shift's SALES into the finance ledger
    // in one atomic transaction. Manual movements were already mirrored on
    // addMovement, so only sales are recorded here (no double-counting).
    const closedShift = await this.dbService.db.transaction(async (tx) => {
      const [closed] = await tx
        .update(cashShifts)
        .set({
          status: 'closed',
          usdRate: dto.usdRate != null ? String(dto.usdRate) : null,
          closedByCashierId: cashier.id,
          closedByCashierName: cashier.name,
          countedCash: cashRow.counted != null ? String(cashRow.counted) : null,
          expectedCash: String(cashRow.expected),
          cashIn: String(cashRow.in),
          cashOut: String(cashRow.out),
          difference: cashRow.diff != null ? String(cashRow.diff) : null,
          reconciliation: rows,
          orderCount,
          note: dto.note ?? null,
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(cashShifts.id, shiftId),
            eq(cashShifts.businessId, businessId),
          ),
        )
        .returning();

      await this.financeService.recordShiftCloseTx(
        tx,
        businessId,
        {
          id: shift.id,
          registerId: shift.registerId,
          registerName: shift.registerName,
        },
        // Net of refunds: a shift that paid out more on returns than it took
        // in posts a negative close, keeping the account balances true.
        {
          cashSales: saleTotals.cashSales - saleTotals.cashRefunds,
          cardSales: saleTotals.cardSales - saleTotals.cardRefunds,
        },
        cashier,
      );

      return closed;
    });
    await this.invalidateOpenShifts(businessId);
    // Fire-and-forget: notify with the Z-report summary (sales + reconciliation).
    this.telegramNotify.notifyShiftClosed(businessId, closedShift, {
      cashSales: saleTotals.cashSales,
      cardSales: saleTotals.cardSales,
    });
    return closedShift;
  }
}
