import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {
  accounts,
  accountBalances,
  financialCategories,
  financialTransactions,
  cashRegisters,
  staff,
  businesses,
  type Account,
  type FinancialCategory,
  type FinancialTransaction,
} from '../database/schema';
import {eq, and, desc, gte, lte, sql, type SQL} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {CreateAccountDto} from './dto/create-account.dto';
import {UpdateAccountDto} from './dto/update-account.dto';
import {CreateFinanceCategoryDto} from './dto/create-finance-category.dto';
import {UpdateFinanceCategoryDto} from './dto/update-finance-category.dto';
import {CreateTransactionDto} from './dto/create-transaction.dto';
import {CreateTransferDto} from './dto/create-transfer.dto';
import {QueryTransactionsDto} from './dto/query-transactions.dto';

export type Currency = 'UZS' | 'USD';

export interface AccountWithBalances extends Account {
  balances: Array<{currency: string; balance: string; frozen: string}>;
}

// Default income/expense categories, seeded the first time a business opens the
// finance module. Merged from the kassa defaults (in→income, out→expense).
const DEFAULT_CATEGORIES: Array<{name: string; kind: 'income' | 'expense'}> = [
  {name: "Do'kon xarajati", kind: 'expense'},
  {name: 'Inkassatsiya', kind: 'expense'},
  {name: 'Ish haqi', kind: 'expense'},
  {name: 'Arenda', kind: 'expense'},
  {name: 'Soliq', kind: 'expense'},
  {name: 'Transport', kind: 'expense'},
  {name: 'Tashqi investitsiya', kind: 'income'},
  {name: 'Boshqa tushum', kind: 'income'},
];

// Non-cash "account" that collects kassa card/non-cash money for a business.
const NONCASH_DEFAULT_NAME = 'Naqdsiz (kassa)';

@Injectable()
export class FinanceService {
  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  // ─── Acting cashier (owner or staff) ──────────────────────────────────────
  private async resolveCashier(
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
      .where(eq(businesses.id, account.id))
      .limit(1);
    return {id: account.id, name: row?.name ?? null};
  }

  // ─── Accounts (Hisoblar) ──────────────────────────────────────────────────

  // Materialise a `cash` account for every active register that doesn't have
  // one yet, so kassa registers show up as finance accounts automatically.
  private async ensureRegisterAccounts(businessId: string): Promise<void> {
    const regs = await this.db
      .select({id: cashRegisters.id, name: cashRegisters.name})
      .from(cashRegisters)
      .where(
        and(
          eq(cashRegisters.businessId, businessId),
          eq(cashRegisters.isActive, true),
        ),
      );
    if (regs.length === 0) return;

    const existing = await this.db
      .select({registerId: accounts.registerId})
      .from(accounts)
      .where(
        and(eq(accounts.businessId, businessId), eq(accounts.type, 'cash')),
      );
    const linked = new Set(existing.map((a) => a.registerId).filter(Boolean));

    const missing = regs.filter((r) => !linked.has(r.id));
    if (missing.length > 0) {
      await this.db.insert(accounts).values(
        missing.map((r) => ({
          id: generateId(),
          businessId,
          name: r.name,
          type: 'cash' as const,
          registerId: r.id,
          isActive: true,
        })),
      );
    }
  }

  async getAccounts(businessId: string): Promise<AccountWithBalances[]> {
    await this.ensureRegisterAccounts(businessId);
    const rows = await this.db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.businessId, businessId), eq(accounts.isActive, true)),
      )
      .orderBy(desc(accounts.createdAt));

    const balances = await this.db
      .select()
      .from(accountBalances)
      .where(eq(accountBalances.businessId, businessId));

    const byAccount = new Map<
      string,
      Array<{currency: string; balance: string; frozen: string}>
    >();
    for (const b of balances) {
      const list = byAccount.get(b.accountId) ?? [];
      list.push({currency: b.currency, balance: b.balance, frozen: b.frozen});
      byAccount.set(b.accountId, list);
    }

    return rows.map((a) => ({...a, balances: byAccount.get(a.id) ?? []}));
  }

  async createAccount(
    businessId: string,
    dto: CreateAccountDto,
  ): Promise<Account> {
    const [account] = await this.db
      .insert(accounts)
      .values({
        id: generateId(),
        businessId,
        name: dto.name,
        type: dto.type,
        registerId: dto.registerId ?? null,
        isActive: true,
      })
      .returning();
    return account;
  }

  async updateAccount(
    businessId: string,
    accountId: string,
    dto: UpdateAccountDto,
  ): Promise<Account> {
    const [existing] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.businessId, businessId)))
      .limit(1);
    if (!existing) throw new NotFoundException('Account not found');

    const [account] = await this.db
      .update(accounts)
      .set({...dto, updatedAt: new Date()})
      .where(and(eq(accounts.id, accountId), eq(accounts.businessId, businessId)))
      .returning();
    return account;
  }

  private async loadAccount(
    businessId: string,
    accountId: string,
  ): Promise<Account> {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.businessId, businessId)))
      .limit(1);
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  // ─── Categories (Toifalar) ────────────────────────────────────────────────
  private async ensureDefaultCategories(businessId: string): Promise<void> {
    const [any] = await this.db
      .select({id: financialCategories.id})
      .from(financialCategories)
      .where(eq(financialCategories.businessId, businessId))
      .limit(1);
    if (any) return;

    await this.db.insert(financialCategories).values(
      DEFAULT_CATEGORIES.map((c) => ({
        id: generateId(),
        businessId,
        name: c.name,
        kind: c.kind,
        isActive: true,
      })),
    );
  }

  async getCategories(
    businessId: string,
    kind?: 'income' | 'expense',
    includeInactive = false,
  ): Promise<FinancialCategory[]> {
    await this.ensureDefaultCategories(businessId);
    const conditions: SQL[] = [eq(financialCategories.businessId, businessId)];
    if (kind) conditions.push(eq(financialCategories.kind, kind));
    if (!includeInactive)
      conditions.push(eq(financialCategories.isActive, true));

    return this.db
      .select()
      .from(financialCategories)
      .where(and(...conditions))
      .orderBy(desc(financialCategories.createdAt));
  }

  async createCategory(
    businessId: string,
    dto: CreateFinanceCategoryDto,
  ): Promise<FinancialCategory> {
    const [category] = await this.db
      .insert(financialCategories)
      .values({
        id: generateId(),
        businessId,
        name: dto.name,
        kind: dto.kind,
        isActive: true,
      })
      .returning();
    return category;
  }

  async updateCategory(
    businessId: string,
    categoryId: string,
    dto: UpdateFinanceCategoryDto,
  ): Promise<FinancialCategory> {
    const [existing] = await this.db
      .select()
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.id, categoryId),
          eq(financialCategories.businessId, businessId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('Category not found');

    const [category] = await this.db
      .update(financialCategories)
      .set(dto)
      .where(
        and(
          eq(financialCategories.id, categoryId),
          eq(financialCategories.businessId, businessId),
        ),
      )
      .returning();
    return category;
  }

  // ─── Balance mutation ─────────────────────────────────────────────────────
  // Atomically add `delta` (may be negative) to an account's balance for a
  // currency, creating the balance row on first touch. Runs inside `tx`.
  private async applyBalanceDelta(
    tx: DbTx,
    businessId: string,
    accountId: string,
    currency: string,
    delta: number,
  ): Promise<void> {
    await tx
      .insert(accountBalances)
      .values({
        id: generateId(),
        businessId,
        accountId,
        currency,
        balance: String(delta),
      })
      .onConflictDoUpdate({
        target: [accountBalances.accountId, accountBalances.currency],
        set: {
          balance: sql`${accountBalances.balance} + ${delta}`,
          updatedAt: new Date(),
        },
      });
  }

  // ─── Transactions (Tranzaksiyalar) ────────────────────────────────────────
  private async createSingle(
    businessId: string,
    kind: 'income' | 'expense',
    dto: CreateTransactionDto,
    account?: IAccount,
  ): Promise<FinancialTransaction> {
    const src = await this.loadAccount(businessId, dto.accountId);

    let categoryName: string | null = null;
    if (dto.categoryId) {
      const [cat] = await this.db
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
    const currency = dto.currency ?? 'UZS';
    const amount = dto.amount;
    const signed = kind === 'income' ? amount : -amount;

    return this.db.transaction(async (tx) => {
      const [txn] = await tx
        .insert(financialTransactions)
        .values({
          id: generateId(),
          businessId,
          kind,
          accountId: src.id,
          accountName: src.name,
          isCash: dto.isCash ?? src.type === 'cash',
          amount: String(amount),
          currency,
          categoryId: dto.categoryId ?? null,
          categoryName,
          cashierId: cashier.id,
          cashierName: cashier.name,
          note: dto.note ?? null,
          operationDate: dto.operationDate ? new Date(dto.operationDate) : null,
        })
        .returning();

      await this.applyBalanceDelta(tx, businessId, src.id, currency, signed);
      return txn;
    });
  }

  createIncome(
    businessId: string,
    dto: CreateTransactionDto,
    account?: IAccount,
  ): Promise<FinancialTransaction> {
    return this.createSingle(businessId, 'income', dto, account);
  }

  createExpense(
    businessId: string,
    dto: CreateTransactionDto,
    account?: IAccount,
  ): Promise<FinancialTransaction> {
    return this.createSingle(businessId, 'expense', dto, account);
  }

  async createTransfer(
    businessId: string,
    dto: CreateTransferDto,
    account?: IAccount,
  ): Promise<FinancialTransaction> {
    if (dto.fromAccountId === dto.toAccountId) {
      throw new BadRequestException('Source and destination must differ');
    }
    const from = await this.loadAccount(businessId, dto.fromAccountId);
    const to = await this.loadAccount(businessId, dto.toAccountId);
    const cashier = await this.resolveCashier(account);
    const currency = dto.currency ?? 'UZS';
    const amount = dto.amount;

    return this.db.transaction(async (tx) => {
      const [txn] = await tx
        .insert(financialTransactions)
        .values({
          id: generateId(),
          businessId,
          kind: 'transfer',
          accountId: from.id,
          accountName: from.name,
          toAccountId: to.id,
          toAccountName: to.name,
          isCash: from.type === 'cash',
          amount: String(amount),
          currency,
          cashierId: cashier.id,
          cashierName: cashier.name,
          note: dto.note ?? null,
          operationDate: dto.operationDate ? new Date(dto.operationDate) : null,
        })
        .returning();

      await this.applyBalanceDelta(tx, businessId, from.id, currency, -amount);
      await this.applyBalanceDelta(tx, businessId, to.id, currency, amount);
      return txn;
    });
  }

  async getTransactions(businessId: string, query: QueryTransactionsDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const offset = (page - 1) * limit;

    const conditions: SQL[] = [
      eq(financialTransactions.businessId, businessId),
    ];
    if (query.kind) conditions.push(eq(financialTransactions.kind, query.kind));
    if (query.accountId)
      conditions.push(eq(financialTransactions.accountId, query.accountId));
    if (query.categoryId)
      conditions.push(eq(financialTransactions.categoryId, query.categoryId));
    if (query.from)
      conditions.push(
        gte(financialTransactions.createdAt, new Date(query.from)),
      );
    if (query.to)
      conditions.push(lte(financialTransactions.createdAt, new Date(query.to)));

    const where = and(...conditions);

    const [rows, totalRow, summary] = await Promise.all([
      this.db
        .select()
        .from(financialTransactions)
        .where(where)
        .orderBy(desc(financialTransactions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({count: sql<number>`count(*)::int`})
        .from(financialTransactions)
        .where(where),
      this.db
        .select({
          kind: financialTransactions.kind,
          currency: financialTransactions.currency,
          total: sql<string>`sum(${financialTransactions.amount})`,
        })
        .from(financialTransactions)
        .where(where)
        .groupBy(financialTransactions.kind, financialTransactions.currency),
    ]);

    return {
      transactions: rows,
      total: totalRow[0]?.count ?? 0,
      page,
      limit,
      summary: summary.map((s) => ({
        kind: s.kind,
        currency: s.currency,
        total: s.total ?? '0',
      })),
    };
  }

  // ─── Kassa integration ────────────────────────────────────────────────────
  // These run INSIDE the caller's db.transaction (ShiftService) so a cash
  // movement / shift close and its ledger row + balance update are atomic.

  private async getOrCreateCashAccountTx(
    tx: DbTx,
    businessId: string,
    registerId: string,
    registerName: string | null,
  ): Promise<Account> {
    const [existing] = await tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.businessId, businessId),
          eq(accounts.registerId, registerId),
          eq(accounts.type, 'cash'),
        ),
      )
      .limit(1);
    if (existing) return existing;

    const [created] = await tx
      .insert(accounts)
      .values({
        id: generateId(),
        businessId,
        name: registerName ?? 'Kassa',
        type: 'cash',
        registerId,
        isActive: true,
      })
      .returning();
    return created;
  }

  private async getOrCreateNoncashAccountTx(
    tx: DbTx,
    businessId: string,
  ): Promise<Account> {
    const [existing] = await tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.businessId, businessId),
          eq(accounts.type, 'noncash'),
          eq(accounts.name, NONCASH_DEFAULT_NAME),
        ),
      )
      .limit(1);
    if (existing) return existing;

    const [created] = await tx
      .insert(accounts)
      .values({
        id: generateId(),
        businessId,
        name: NONCASH_DEFAULT_NAME,
        type: 'noncash',
        isActive: true,
      })
      .returning();
    return created;
  }

  /** Mirror a kassa cash movement into the ledger (in→income, out→expense). */
  async recordCashMovementTx(
    tx: DbTx,
    businessId: string,
    movement: {
      id: string;
      shiftId: string;
      registerId: string | null;
      type: string; // 'in' | 'out'
      isCash: boolean;
      amount: string;
      currency: string;
      categoryId: string | null;
      categoryName: string | null;
      cashierId: string | null;
      cashierName: string | null;
    },
    register: {id: string; name: string | null},
  ): Promise<void> {
    const account = movement.isCash
      ? await this.getOrCreateCashAccountTx(
          tx,
          businessId,
          register.id,
          register.name,
        )
      : await this.getOrCreateNoncashAccountTx(tx, businessId);

    const kind = movement.type === 'in' ? 'income' : 'expense';
    const amt = Number(movement.amount);
    const signed = kind === 'income' ? amt : -amt;

    await tx.insert(financialTransactions).values({
      id: generateId(),
      businessId,
      kind,
      accountId: account.id,
      accountName: account.name,
      isCash: movement.isCash,
      amount: movement.amount,
      currency: movement.currency,
      categoryId: movement.categoryId,
      categoryName: movement.categoryName,
      cashierId: movement.cashierId,
      cashierName: movement.cashierName,
      shiftId: movement.shiftId,
      cashMovementId: movement.id,
    });

    await this.applyBalanceDelta(
      tx,
      businessId,
      account.id,
      movement.currency,
      signed,
    );
  }

  /**
   * Record a shift's SALES into the ledger on close (manual movements are
   * already mirrored by recordCashMovementTx, so only sales are added here to
   * avoid double-counting). Cash sales → register cash account; card sales →
   * the shared non-cash account. Sales are UZS today.
   */
  async recordShiftCloseTx(
    tx: DbTx,
    businessId: string,
    shift: {id: string; registerId: string; registerName: string | null},
    saleTotals: {cashSales: number; cardSales: number},
    cashier: {id: string | null; name: string | null},
  ): Promise<void> {
    const currency = 'UZS';

    if (saleTotals.cashSales > 0) {
      const cashAccount = await this.getOrCreateCashAccountTx(
        tx,
        businessId,
        shift.registerId,
        shift.registerName,
      );
      await tx.insert(financialTransactions).values({
        id: generateId(),
        businessId,
        kind: 'shift_close',
        accountId: cashAccount.id,
        accountName: cashAccount.name,
        isCash: true,
        amount: String(saleTotals.cashSales),
        currency,
        cashierId: cashier.id,
        cashierName: cashier.name,
        shiftId: shift.id,
      });
      await this.applyBalanceDelta(
        tx,
        businessId,
        cashAccount.id,
        currency,
        saleTotals.cashSales,
      );
    }

    if (saleTotals.cardSales > 0) {
      const bankAccount = await this.getOrCreateNoncashAccountTx(
        tx,
        businessId,
      );
      await tx.insert(financialTransactions).values({
        id: generateId(),
        businessId,
        kind: 'shift_close',
        accountId: bankAccount.id,
        accountName: bankAccount.name,
        isCash: false,
        amount: String(saleTotals.cardSales),
        currency,
        cashierId: cashier.id,
        cashierName: cashier.name,
        shiftId: shift.id,
      });
      await this.applyBalanceDelta(
        tx,
        businessId,
        bankAccount.id,
        currency,
        saleTotals.cardSales,
      );
    }
  }

  /**
   * Book an expense inside the caller's transaction (e.g. a supplier payment
   * from the receipt module). Inserts the ledger row and debits the account
   * balance atomically; returns the created transaction.
   */
  async recordExpenseTx(
    tx: DbTx,
    businessId: string,
    params: {
      accountId: string;
      amount: number;
      currency: string;
      note?: string | null;
      categoryId?: string | null;
      categoryName?: string | null;
      cashierId?: string | null;
      cashierName?: string | null;
    },
  ): Promise<FinancialTransaction> {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.id, params.accountId),
          eq(accounts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!account) throw new NotFoundException('Account not found');

    const [txn] = await tx
      .insert(financialTransactions)
      .values({
        id: generateId(),
        businessId,
        kind: 'expense',
        accountId: account.id,
        accountName: account.name,
        isCash: account.type === 'cash',
        amount: String(params.amount),
        currency: params.currency,
        categoryId: params.categoryId ?? null,
        categoryName: params.categoryName ?? null,
        cashierId: params.cashierId ?? null,
        cashierName: params.cashierName ?? null,
        note: params.note ?? null,
      })
      .returning();

    await this.applyBalanceDelta(
      tx,
      businessId,
      account.id,
      params.currency,
      -params.amount,
    );
    return txn;
  }

  // ─── Category mapping helpers (kassa compat) ──────────────────────────────
  // Kassa still speaks direction (in/out/both); finance stores kind. These map
  // between them so the kassa module can share the single categories table.
  async getCategoriesAsDirection(businessId: string): Promise<
    Array<{
      id: string;
      businessId: string;
      name: string;
      direction: 'in' | 'out';
      isActive: boolean;
      createdAt: Date;
    }>
  > {
    const cats = await this.getCategories(businessId);
    return cats.map((c) => ({
      id: c.id,
      businessId: c.businessId,
      name: c.name,
      direction: c.kind === 'income' ? ('in' as const) : ('out' as const),
      isActive: c.isActive,
      createdAt: c.createdAt,
    }));
  }
}

// Drizzle transaction handle type (parameter of db.transaction callback).
type DbTx = Parameters<
  Parameters<DatabaseService['db']['transaction']>[0]
>[0];
