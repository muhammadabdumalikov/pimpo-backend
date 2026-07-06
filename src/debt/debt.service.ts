import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { userDebts, debtPayments, users, type UserDebt, type NewDebtPayment, type DebtPayment, type NewUserDebt, type User } from '../database/schema';
import { eq, and, asc, desc, ilike, or, count, lt, gte, lte, sql, inArray } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { SubscriptionService } from '../subscription/subscription.service';
import { UserService } from '../user/user.service';

@Injectable()
export class DebtService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
    private readonly userService: UserService,
  ) {}

  async create(businessId: string, data: {
    userId?: string;
    userName?: string;
    phone?: string;
    amount: string;
    status?: string;
    dueDate: string;
    description?: string;
  }): Promise<UserDebt & { user: User }> {
    // Check debt limit
    const { debtsLimit } = await this.subscriptionService.getSubscriptionLimits(businessId);
    const currentDebtCount = await this.getCount(businessId);

    if (debtsLimit !== null && currentDebtCount >= debtsLimit) {
      throw new ForbiddenException(`Debt limit of ${debtsLimit} reached for your current plan.`);
    }

    // Find or create user
    let userId: string;
    if (data.userId) {
      const user = await this.userService.findOne(businessId, data.userId);
      if (!user) {
        throw new NotFoundException('User not found');
      }
      userId = user.id;
    } else if (data.userName && data.phone) {
      // Try to find existing user by phone
      let user = await this.userService.findByPhone(businessId, data.phone);
      if (!user) {
        // Create new user
        user = await this.userService.create(businessId, {
          name: data.userName,
          phone: data.phone,
        });
      }
      userId = user.id;
    } else {
      throw new NotFoundException('User ID or user name and phone are required');
    }

    const newDebt: NewUserDebt = {
      id: generateId(),
      businessId,
      userId,
      amount: data.amount,
      status: (data.status || 'Pending') as 'Paid' | 'Pending' | 'Overdue',
      dueDate: new Date(data.dueDate),
      description: data.description || null,
    };

    const [debt] = await this.dbService.db
      .insert(userDebts)
      .values(newDebt)
      .returning();

    // Fetch user data for response
    const user = await this.userService.findOne(businessId, userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      ...debt,
      user,
    } as any;
  }

  /**
   * Mark any of this business's still-"Pending" debts whose due date has passed
   * as "Overdue". Idempotent; run on read so listings always reflect reality.
   */
  private async applyOverdue(businessId: string): Promise<void> {
    await this.dbService.db
      .update(userDebts)
      .set({ status: 'Overdue', updatedAt: new Date() })
      .where(
        and(
          eq(userDebts.businessId, businessId),
          eq(userDebts.status, 'Pending'),
          lt(userDebts.dueDate, new Date()),
        ),
      );
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
    },
  ): Promise<{ debts: (UserDebt & { user: User })[]; total: number; page: number; limit: number }> {
    await this.applyOverdue(businessId);
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;
    const search = options?.search;
    const status = options?.status;

    // Build where conditions
    const whereConditions = [eq(userDebts.businessId, businessId)];

    if (status) {
      whereConditions.push(eq(userDebts.status, status as 'Paid' | 'Pending' | 'Overdue'));
    }

    // Date range on when the debt was created (inclusive).
    if (options?.dateFrom) {
      whereConditions.push(gte(userDebts.createdAt, new Date(options.dateFrom)));
    }
    if (options?.dateTo) {
      const to = new Date(options.dateTo);
      to.setHours(23, 59, 59, 999);
      whereConditions.push(lte(userDebts.createdAt, to));
    }

    // Build search conditions for database query
    if (search) {
      whereConditions.push(
        or(
          ilike(users.name, `%${search}%`),
          ilike(users.phone, `%${search}%`),
          ilike(userDebts.description, `%${search}%`),
        )!,
      );
    }

    // Get total count (always join with users since we might be searching by user fields)
    const totalResult = await this.dbService.db
      .select({ count: count() })
      .from(userDebts)
      .innerJoin(users, eq(userDebts.userId, users.id))
      .where(and(...whereConditions));
    const total = totalResult[0].count;

    // Get paginated results with user data
    const paginatedDebts = await this.dbService.db
      .select({
        debt: userDebts,
        user: users,
      })
      .from(userDebts)
      .innerJoin(users, eq(userDebts.userId, users.id))
      .where(and(...whereConditions))
      .orderBy(desc(userDebts.createdAt))
      .limit(limit)
      .offset(offset);

    // Map to response format
    const debts = paginatedDebts.map((row) => ({
      ...row.debt,
      user: row.user,
    }));

    return {
      debts: debts as any,
      total,
      page,
      limit,
    };
  }

  /**
   * Debts grouped by customer, aggregated + sorted + paginated entirely in the
   * database. Each returned group also carries its (filtered) debts nested, so
   * the UI can render and expand without a second round-trip.
   */
  async findGrouped(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
      sortBy?: 'date' | 'amount' | 'count';
      sortDir?: 'asc' | 'desc';
    },
  ): Promise<{
    groups: {
      userId: string;
      userName: string;
      phone: string;
      totalDebt: number;
      totalRemaining: number;
      debtCount: number;
      latestDate: Date | null;
      debts: (UserDebt & { user: User; paid: number; remaining: number })[];
    }[];
    total: number;
    page: number;
    limit: number;
  }> {
    await this.applyOverdue(businessId);
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;
    const sortBy = options?.sortBy || 'date';
    const sortDir = options?.sortDir === 'asc' ? 'asc' : 'desc';

    // Shared filters (same as findAll).
    const whereConditions = [eq(userDebts.businessId, businessId)];
    if (options?.status) {
      whereConditions.push(
        eq(userDebts.status, options.status as 'Paid' | 'Pending' | 'Overdue'),
      );
    }
    if (options?.dateFrom) {
      whereConditions.push(gte(userDebts.createdAt, new Date(options.dateFrom)));
    }
    if (options?.dateTo) {
      const to = new Date(options.dateTo);
      to.setHours(23, 59, 59, 999);
      whereConditions.push(lte(userDebts.createdAt, to));
    }
    if (options?.search) {
      whereConditions.push(
        or(
          ilike(users.name, `%${options.search}%`),
          ilike(users.phone, `%${options.search}%`),
          ilike(userDebts.description, `%${options.search}%`),
        )!,
      );
    }
    const where = and(...whereConditions);

    // Total number of distinct customers (groups) matching the filters.
    const groupKeys = await this.dbService.db
      .select({ userId: userDebts.userId })
      .from(userDebts)
      .innerJoin(users, eq(userDebts.userId, users.id))
      .where(where)
      .groupBy(userDebts.userId);
    const total = groupKeys.length;

    // Order by the chosen aggregate + direction.
    const totalExpr = sql`SUM(${userDebts.amount})`;
    const countExpr = sql`COUNT(*)`;
    const latestExpr = sql`MAX(${userDebts.createdAt})`;
    const sortExpr =
      sortBy === 'amount' ? totalExpr : sortBy === 'count' ? countExpr : latestExpr;

    const pageGroups = await this.dbService.db
      .select({
        userId: users.id,
        userName: users.name,
        phone: users.phone,
        totalDebt: totalExpr.mapWith(Number),
        debtCount: countExpr.mapWith(Number),
        latestDate: latestExpr.mapWith((v) => (v ? new Date(v as string) : null)),
      })
      .from(userDebts)
      .innerJoin(users, eq(userDebts.userId, users.id))
      .where(where)
      .groupBy(users.id, users.name, users.phone)
      .orderBy(sortDir === 'asc' ? asc(sortExpr) : desc(sortExpr))
      .limit(limit)
      .offset(offset);

    if (pageGroups.length === 0) {
      return { groups: [], total, page, limit };
    }

    // Nest each group's debts (same filters, scoped to the page's customers).
    const userIds = pageGroups.map((g) => g.userId);
    const debtRows = await this.dbService.db
      .select({ debt: userDebts, user: users })
      .from(userDebts)
      .innerJoin(users, eq(userDebts.userId, users.id))
      .where(and(where, inArray(userDebts.userId, userIds)))
      .orderBy(desc(userDebts.createdAt));

    // How much has been paid on each debt so far (installment payments).
    const paidByDebt = await this.getPaidByDebt(
      businessId,
      debtRows.map((r) => r.debt.id),
    );

    const byUser = new Map<
      string,
      (UserDebt & { user: User; paid: number; remaining: number })[]
    >();
    for (const row of debtRows) {
      const paid = paidByDebt.get(row.debt.id) ?? 0;
      const remaining = Number(row.debt.amount) - paid;
      const list = byUser.get(row.debt.userId) ?? [];
      list.push({ ...row.debt, user: row.user, paid, remaining });
      byUser.set(row.debt.userId, list);
    }

    const groups = pageGroups.map((g) => {
      const debts = byUser.get(g.userId) ?? [];
      const totalRemaining = debts.reduce((sum, d) => sum + d.remaining, 0);
      return {
        userId: g.userId,
        userName: g.userName,
        phone: g.phone,
        totalDebt: g.totalDebt,
        totalRemaining,
        debtCount: g.debtCount,
        latestDate: g.latestDate,
        debts,
      };
    });

    return { groups, total, page, limit };
  }

  async findOne(businessId: string, debtId: string): Promise<(UserDebt & { user: User }) | null> {
    await this.applyOverdue(businessId);
    const [result] = await this.dbService.db
      .select({
        debt: userDebts,
        user: users,
      })
      .from(userDebts)
      .innerJoin(users, eq(userDebts.userId, users.id))
      .where(
        and(
          eq(userDebts.id, debtId),
          eq(userDebts.businessId, businessId),
        ),
      )
      .limit(1);

    if (!result) {
      return null;
    }

    return {
      ...result.debt,
      user: result.user,
    } as any;
  }

  async findByUser(
    businessId: string,
    userId: string,
  ): Promise<(UserDebt & { user: User })[]> {
    await this.applyOverdue(businessId);
    const results = await this.dbService.db
      .select({
        debt: userDebts,
        user: users,
      })
      .from(userDebts)
      .innerJoin(users, eq(userDebts.userId, users.id))
      .where(
        and(
          eq(userDebts.businessId, businessId),
          eq(userDebts.userId, userId),
        ),
      )
      .orderBy(desc(userDebts.createdAt));

    return results.map((row) => ({
      ...row.debt,
      user: row.user,
    })) as any;
  }

  async update(
    businessId: string,
    debtId: string,
    data: {
      userId?: string;
      userName?: string;
      phone?: string;
      amount?: string;
      status?: string;
      dueDate?: string;
      description?: string;
    },
  ): Promise<UserDebt & { user: User }> {
    const existing = await this.findOne(businessId, debtId);
    if (!existing) {
      throw new NotFoundException('Debt not found');
    }

    // Handle user updates if userName or phone are provided
    if (data.userName || data.phone) {
      await this.userService.update(businessId, existing.user.id, {
        name: data.userName,
        phone: data.phone,
      });
    }

    // Handle userId change if provided
    if (data.userId && data.userId !== existing.userId) {
      const newUser = await this.userService.findOne(businessId, data.userId);
      if (!newUser) {
        throw new NotFoundException('User not found');
      }
    }

    // Prepare debt update data
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (data.amount !== undefined) {
      updateData.amount = data.amount;
    }
    if (data.status !== undefined) {
      updateData.status = data.status as 'Paid' | 'Pending' | 'Overdue';
    }
    if (data.dueDate !== undefined) {
      updateData.dueDate = new Date(data.dueDate);
    }
    if (data.description !== undefined) {
      updateData.description = data.description || null;
    }
    if (data.userId !== undefined && data.userId !== existing.userId) {
      updateData.userId = data.userId;
    }

    const [debt] = await this.dbService.db
      .update(userDebts)
      .set(updateData)
      .where(
        and(
          eq(userDebts.id, debtId),
          eq(userDebts.businessId, businessId),
        ),
      )
      .returning();

    // Fetch updated user data
    const userId = data.userId || existing.userId;
    const user = await this.userService.findOne(businessId, userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      ...debt,
      user,
    } as any;
  }

  async remove(businessId: string, debtId: string): Promise<void> {
    const existing = await this.findOne(businessId, debtId);
    if (!existing) {
      throw new NotFoundException('Debt not found');
    }

    await this.dbService.db
      .delete(userDebts)
      .where(
        and(
          eq(userDebts.id, debtId),
          eq(userDebts.businessId, businessId),
        ),
      );
  }

  async getCount(businessId: string): Promise<number> {
    const result = await this.dbService.db
      .select({ count: count() })
      .from(userDebts)
      .where(eq(userDebts.businessId, businessId));

    return result[0].count;
  }

  // ─── Installment payments (Pro tier) ───────────────────────────────────────

  /** Partial debt repayment + payment history are a Pro-plan feature. */
  private async requirePro(businessId: string): Promise<void> {
    const subscription =
      await this.subscriptionService.getBusinessSubscription(businessId);
    const tier = subscription?.plan.tier ?? 'free';
    if (tier !== 'pro') {
      throw new ForbiddenException(
        'Installment debt payments are available on the Pro plan.',
      );
    }
  }

  /** Total paid per debt id → Map(debtId, paidAmount). */
  private async getPaidByDebt(
    businessId: string,
    debtIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (debtIds.length === 0) return map;
    const rows = await this.dbService.db
      .select({
        debtId: debtPayments.debtId,
        paid: sql`SUM(${debtPayments.amount})`.mapWith(Number),
      })
      .from(debtPayments)
      .where(
        and(
          eq(debtPayments.businessId, businessId),
          inArray(debtPayments.debtId, debtIds),
        ),
      )
      .groupBy(debtPayments.debtId);
    for (const r of rows) map.set(r.debtId, r.paid ?? 0);
    return map;
  }

  /**
   * Derive and persist a debt's status from amount vs total paid:
   * Paid (fully covered) → Partial (some paid) → Overdue (past due) → Pending.
   */
  private async recomputeDebtStatus(
    businessId: string,
    debt: UserDebt,
  ): Promise<string> {
    const paidMap = await this.getPaidByDebt(businessId, [debt.id]);
    const paid = paidMap.get(debt.id) ?? 0;
    const total = Number(debt.amount);
    let status: string;
    if (paid >= total) status = 'Paid';
    else if (paid > 0) status = 'Partial';
    else if (debt.dueDate && new Date(debt.dueDate) < new Date())
      status = 'Overdue';
    else status = 'Pending';

    await this.dbService.db
      .update(userDebts)
      .set({ status: status as any, updatedAt: new Date() })
      .where(
        and(eq(userDebts.id, debt.id), eq(userDebts.businessId, businessId)),
      );
    return status;
  }

  /** Record an installment payment against a debt (capped at the remaining balance). */
  async addPayment(
    businessId: string,
    debtId: string,
    data: { amount: string; method?: 'cash' | 'card'; note?: string },
  ): Promise<{
    debt: UserDebt & { user: User; paid: number; remaining: number };
    payment: DebtPayment;
  }> {
    await this.requirePro(businessId);
    const debt = await this.findOne(businessId, debtId);
    if (!debt) throw new NotFoundException('Debt not found');

    const paidMap = await this.getPaidByDebt(businessId, [debtId]);
    const alreadyPaid = paidMap.get(debtId) ?? 0;
    const total = Number(debt.amount);
    const remaining = total - alreadyPaid;
    const amount = Number(data.amount);

    if (!(amount > 0)) {
      throw new BadRequestException('Payment amount must be greater than 0.');
    }
    // Small epsilon so exact-to-the-cent full payments aren't rejected.
    if (amount > remaining + 1e-9) {
      throw new BadRequestException(
        `Payment exceeds the remaining balance (${remaining.toFixed(2)}).`,
      );
    }

    const newPayment: NewDebtPayment = {
      id: generateId(),
      businessId,
      debtId,
      amount: data.amount,
      method: data.method || 'cash',
      note: data.note || null,
    };
    const [payment] = await this.dbService.db
      .insert(debtPayments)
      .values(newPayment)
      .returning();

    const status = await this.recomputeDebtStatus(businessId, debt);
    const newPaid = alreadyPaid + amount;
    return {
      debt: {
        ...debt,
        status: status as any,
        paid: newPaid,
        remaining: total - newPaid,
      },
      payment,
    };
  }

  /** Payment history for a debt (newest first). */
  async listPayments(
    businessId: string,
    debtId: string,
  ): Promise<DebtPayment[]> {
    await this.requirePro(businessId);
    const debt = await this.findOne(businessId, debtId);
    if (!debt) throw new NotFoundException('Debt not found');
    return this.dbService.db
      .select()
      .from(debtPayments)
      .where(
        and(
          eq(debtPayments.businessId, businessId),
          eq(debtPayments.debtId, debtId),
        ),
      )
      .orderBy(desc(debtPayments.createdAt));
  }

  /** Remove a payment (e.g. entered by mistake) and recompute the debt status. */
  async deletePayment(
    businessId: string,
    debtId: string,
    paymentId: string,
  ): Promise<void> {
    await this.requirePro(businessId);
    const debt = await this.findOne(businessId, debtId);
    if (!debt) throw new NotFoundException('Debt not found');

    const [existing] = await this.dbService.db
      .select()
      .from(debtPayments)
      .where(
        and(
          eq(debtPayments.id, paymentId),
          eq(debtPayments.debtId, debtId),
          eq(debtPayments.businessId, businessId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('Payment not found');

    await this.dbService.db
      .delete(debtPayments)
      .where(eq(debtPayments.id, paymentId));
    await this.recomputeDebtStatus(businessId, debt);
  }
}
