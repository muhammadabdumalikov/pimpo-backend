import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {
  cashRegisters,
  cashOperationCategories,
  cashShifts,
  cashMovements,
  orders,
  staff,
  businesses,
  type CashRegister,
  type CashOperationCategory,
  type CashShift,
  type CashMovement,
} from '../database/schema';
import {eq, and, desc, ne} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {OpenShiftDto} from './dto/open-shift.dto';
import {CreateCashMovementDto} from './dto/create-cash-movement.dto';
import {CloseShiftDto} from './dto/close-shift.dto';
import {computeReconciliation, type ReconRow} from './reconciliation';

export type {ReconRow};

export interface ShiftReport {
  shift: CashShift;
  movements: CashMovement[];
  reconciliation: ReconRow[];
  orderCount: number;
}

// Default register + categories created for a business the first time it touches
// the kassa module, so existing businesses keep working without a data migration.
const DEFAULT_REGISTER_NAME = 'Asosiy kassa';
const DEFAULT_CATEGORIES: Array<{
  name: string;
  direction: 'in' | 'out' | 'both';
}> = [
  {name: "Do'kon xarajati", direction: 'out'},
  {name: 'Inkassatsiya', direction: 'out'},
  {name: 'Ish haqi', direction: 'out'},
  {name: "Maydalik qo'shildi", direction: 'in'},
  {name: 'Boshqa', direction: 'both'},
];

@Injectable()
export class ShiftService {
  constructor(private readonly dbService: DatabaseService) {}

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

  // Seed default categories once; dedupe by name if a race duplicated them.
  private async ensureDefaultCategories(businessId: string): Promise<void> {
    const cats = await this.dbService.db
      .select({
        id: cashOperationCategories.id,
        name: cashOperationCategories.name,
        createdAt: cashOperationCategories.createdAt,
      })
      .from(cashOperationCategories)
      .where(
        and(
          eq(cashOperationCategories.businessId, businessId),
          eq(cashOperationCategories.isActive, true),
        ),
      )
      .orderBy(cashOperationCategories.createdAt);

    if (cats.length === 0) {
      await this.dbService.db.insert(cashOperationCategories).values(
        DEFAULT_CATEGORIES.map((c) => ({
          id: generateId(),
          businessId,
          name: c.name,
          direction: c.direction,
          isActive: true,
        })),
      );
      return;
    }

    // Deactivate later duplicates sharing a name (movements keep their snapshot).
    const seen = new Set<string>();
    for (const c of cats) {
      if (seen.has(c.name)) {
        await this.dbService.db
          .update(cashOperationCategories)
          .set({isActive: false})
          .where(eq(cashOperationCategories.id, c.id));
      } else {
        seen.add(c.name);
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
  async getCashCategories(
    businessId: string,
  ): Promise<CashOperationCategory[]> {
    await this.ensureDefaultCategories(businessId);
    return this.dbService.db
      .select()
      .from(cashOperationCategories)
      .where(
        and(
          eq(cashOperationCategories.businessId, businessId),
          eq(cashOperationCategories.isActive, true),
        ),
      )
      .orderBy(desc(cashOperationCategories.createdAt));
  }

  async createCashCategory(
    businessId: string,
    data: {name: string; direction?: 'in' | 'out' | 'both'},
  ): Promise<CashOperationCategory> {
    const [category] = await this.dbService.db
      .insert(cashOperationCategories)
      .values({
        id: generateId(),
        businessId,
        name: data.name,
        direction: data.direction ?? 'both',
        isActive: true,
      })
      .returning();
    return category;
  }

  async updateCashCategory(
    businessId: string,
    categoryId: string,
    data: {
      name?: string;
      direction?: 'in' | 'out' | 'both';
      isActive?: boolean;
    },
  ): Promise<CashOperationCategory> {
    const [existing] = await this.dbService.db
      .select()
      .from(cashOperationCategories)
      .where(
        and(
          eq(cashOperationCategories.id, categoryId),
          eq(cashOperationCategories.businessId, businessId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('Category not found');

    const [category] = await this.dbService.db
      .update(cashOperationCategories)
      .set(data)
      .where(
        and(
          eq(cashOperationCategories.id, categoryId),
          eq(cashOperationCategories.businessId, businessId),
        ),
      )
      .returning();
    return category;
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

  async openShift(
    businessId: string,
    dto: OpenShiftDto,
    account?: IAccount,
  ): Promise<CashShift> {
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
        .from(cashOperationCategories)
        .where(
          and(
            eq(cashOperationCategories.id, dto.categoryId),
            eq(cashOperationCategories.businessId, businessId),
          ),
        )
        .limit(1);
      if (!cat) throw new NotFoundException('Category not found');
      categoryName = cat.name;
    }

    const cashier = await this.resolveCashier(account);
    const [movement] = await this.dbService.db
      .insert(cashMovements)
      .values({
        id: generateId(),
        businessId,
        shiftId: shift.id,
        registerId: shift.registerId,
        type: dto.type,
        isCash: dto.isCash ?? true,
        amount: String(dto.amount),
        currency: dto.currency ?? 'UZS',
        categoryId: dto.categoryId ?? null,
        categoryName,
        reason: dto.reason ?? null,
        cashierId: cashier.id,
        cashierName: cashier.name,
      })
      .returning();
    return movement;
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
  ): Promise<{rows: ReconRow[]; orderCount: number; hasUsd: boolean}> {
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
    const {rows, orderCount} = await this.buildReconciliation(
      shift,
      movements,
      counted,
    );

    // Scalar UZS-cash summary (the row stores den-per-normalised).
    const cashRow = rows.find(
      (r) => r.method === 'cash' && r.currency === 'UZS',
    )!;
    const cashier = await this.resolveCashier(account);

    const [closed] = await this.dbService.db
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
    return closed;
  }
}
