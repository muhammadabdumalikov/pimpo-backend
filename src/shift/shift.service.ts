import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {
  cashRegisters,
  cashShifts,
  cashMovements,
  financialCategories,
  orders,
  staff,
  businesses,
  type CashRegister,
  type CashShift,
  type CashMovement,
} from '../database/schema';
import {eq, and, desc, ne, sql} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {FinanceService} from '../finance/finance.service';
import {OpenShiftDto} from './dto/open-shift.dto';
import {CreateCashMovementDto} from './dto/create-cash-movement.dto';
import {CloseShiftDto} from './dto/close-shift.dto';
import {computeReconciliation, type ReconRow} from './reconciliation';

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

@Injectable()
export class ShiftService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly financeService: FinanceService,
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
      await this.dbService.db.insert(cashRegisters).values({
        id: generateId(),
        businessId,
        name: DEFAULT_REGISTER_NAME,
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
    data: {name: string; storeId?: string},
  ): Promise<CashRegister> {
    const [register] = await this.dbService.db
      .insert(cashRegisters)
      .values({
        id: generateId(),
        businessId,
        name: data.name,
        storeId: data.storeId ?? null,
        isActive: true,
      })
      .returning();
    return register;
  }

  async updateRegister(
    businessId: string,
    registerId: string,
    data: {name?: string; isActive?: boolean},
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
    if (!existing) throw new NotFoundException('Register not found');

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

  /** All currently open shifts for the business (one per register at most). */
  async getOpenShifts(businessId: string): Promise<CashShift[]> {
    return this.dbService.db
      .select()
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.businessId, businessId),
          eq(cashShifts.status, 'open'),
        ),
      )
      .orderBy(desc(cashShifts.openedAt));
  }

  // Blocks opening a shift while an inventory count is in progress. Raw guarded
  // query so it stays decoupled from the stock-take module and never throws if
  // that table hasn't been migrated yet (fail-open, mirrors OrderService).
  private async assertNoStockTakeInProgress(businessId: string): Promise<void> {
    try {
      // db.execute() returns a bare row array or a { rows } object depending on
      // the driver — normalise both.
      const result = (await this.dbService.db.execute(sql`
        SELECT 1 FROM stock_takes
        WHERE business_id = ${businessId} AND status = 'in_progress'
        LIMIT 1
      `)) as unknown;
      const rows =
        (result as {rows?: unknown[]}).rows ?? (result as unknown[]);
      if (rows.length > 0) {
        throw new ForbiddenException(
          'A stock-take is in progress. The cash register cannot be opened until it is completed.',
        );
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // Table missing / transient error — don't block the till.
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
    if (!register) throw new NotFoundException('Register not found');

    // One open shift per register.
    const current = await this.getCurrentShift(businessId, dto.registerId);
    if (current) {
      throw new BadRequestException(
        'This register already has an open shift. Close it first.',
      );
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
    if (!shift) throw new NotFoundException('Shift not found');
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
      throw new BadRequestException('Shift is already closed');
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
      if (!cat) throw new NotFoundException('Category not found');
      categoryName = cat.name;
    }

    const cashier = await this.resolveCashier(account);
    const isCash = dto.isCash ?? true;
    const currency = dto.currency ?? 'UZS';

    // Insert the movement and mirror it into the finance ledger + balance in one
    // atomic transaction, so the two never drift apart.
    return this.dbService.db.transaction(async (tx) => {
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
    saleTotals: {cashSales: number; cardSales: number; debtSales: number};
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

    // Pure math lives in ./reconciliation (unit-tested there).
    return computeReconciliation({
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
      throw new BadRequestException(
        'Only the cashier who opened this shift (or an owner) can close it',
      );
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
    return this.dbService.db.transaction(async (tx) => {
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
          and(eq(cashShifts.id, shiftId), eq(cashShifts.businessId, businessId)),
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
        {cashSales: saleTotals.cashSales, cardSales: saleTotals.cardSales},
        cashier,
      );

      return closed;
    });
  }
}
