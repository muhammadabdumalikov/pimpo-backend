import {
  Injectable,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {businessDayStart, businessDayEnd} from '../common/business-time';
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
import {eq, and, ne, desc, gte, lte, inArray, sql, type SQL} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {displayAmount} from '../common/display-amount';
import {IAccount} from '../business/types';
import {CreateAccountDto} from './dto/create-account.dto';
import {UpdateAccountDto} from './dto/update-account.dto';
import {CreateFinanceCategoryDto} from './dto/create-finance-category.dto';
import {UpdateFinanceCategoryDto} from './dto/update-finance-category.dto';
import {CreateTransactionDto} from './dto/create-transaction.dto';
import {CreateTransferDto} from './dto/create-transfer.dto';
import {QueryTransactionsDto} from './dto/query-transactions.dto';
import {CancelTransactionDto} from './dto/cancel-transaction.dto';
import {
  CANCELLABLE_SOURCES,
  capitalRow,
  liveRow,
  type FinanceSource,
} from './ledger-rules';

export type Currency = 'UZS' | 'USD';

export interface AccountWithBalances extends Account {
  balances: Array<{currency: string; balance: string; frozen: string}>;
}

// Default income/expense categories, seeded the first time a business opens the
// finance module. Merged from the kassa defaults (in→income, out→expense).
// Capital ones move money between the owner and the shop and stay out of the
// P&L — inkassatsiya only changes where the cash sits.
const DEFAULT_CATEGORIES: Array<{
  name: string;
  kind: 'income' | 'expense';
  isCapital?: boolean;
}> = [
  {name: "Do'kon xarajati", kind: 'expense'},
  {name: 'Inkassatsiya', kind: 'expense', isCapital: true},
  {name: 'Ish haqi', kind: 'expense'},
  {name: 'Arenda', kind: 'expense'},
  {name: 'Soliq', kind: 'expense'},
  {name: 'Transport', kind: 'expense'},
  {name: 'Tashqi investitsiya', kind: 'income', isCapital: true},
  {name: "Boshlang'ich qoldiq", kind: 'income', isCapital: true},
  {name: 'Boshqa tushum', kind: 'income'},
];

// The capital income category the kirim leg of a "Tashqi mablag'" pair uses.
const CAPITAL_INCOME_CATEGORY_NAME = 'Tashqi investitsiya';

// The hidden system account "Tashqi mablag'" pairs are booked on.
const EXTERNAL_ACCOUNT_NAME = "Tashqi mablag'";

// How money going out is funded: a shop account (debited, refused below zero
// unless the user confirmed) or the owner's own pocket.
export interface FundingOptions {
  accountId?: string | null;
  external?: boolean;
  allowNegative?: boolean;
}

// Non-cash "account" that collects kassa card/non-cash money for a business.
const NONCASH_DEFAULT_NAME = 'Naqdsiz (kassa)';

// Expense category salary payments are booked under (see PayrollService).
export const PAYROLL_CATEGORY_NAME = 'Ish haqi';

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
        and(
          eq(accounts.businessId, businessId),
          eq(accounts.isActive, true),
          ne(accounts.type, 'external'),
        ),
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
    if (!existing || existing.type === 'external') {
      throw new AppException(ErrorCode.FINANCE_ACCOUNT_NOT_FOUND);
    }

    const [account] = await this.db
      .update(accounts)
      .set({...dto, updatedAt: new Date()})
      .where(and(eq(accounts.id, accountId), eq(accounts.businessId, businessId)))
      .returning();
    return account;
  }

  // A shop account picked by id. The external account is never addressable
  // this way — it is reached only through `external: true`.
  private async loadAccount(
    businessId: string,
    accountId: string,
    db: DbTx | DatabaseService['db'] = this.db,
  ): Promise<Account> {
    const [account] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.businessId, businessId)))
      .limit(1);
    if (!account || account.type === 'external') {
      throw new AppException(ErrorCode.FINANCE_ACCOUNT_NOT_FOUND);
    }
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
        isCapital: c.isCapital ?? false,
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

  /**
   * The expense category payroll payments post under. Normally seeded by
   * ensureDefaultCategories, but a business can rename or deactivate it — so
   * re-create it on demand rather than letting a salary payment land
   * uncategorised in the ledger.
   */
  async getOrCreatePayrollCategory(
    businessId: string,
  ): Promise<FinancialCategory> {
    await this.ensureDefaultCategories(businessId);
    const [existing] = await this.db
      .select()
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.businessId, businessId),
          eq(financialCategories.name, PAYROLL_CATEGORY_NAME),
          eq(financialCategories.kind, 'expense'),
        ),
      )
      .limit(1);
    if (existing) return existing;

    const [created] = await this.db
      .insert(financialCategories)
      .values({
        id: generateId(),
        businessId,
        name: PAYROLL_CATEGORY_NAME,
        kind: 'expense',
        isActive: true,
      })
      .returning();
    return created;
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
        isCapital: dto.isCapital ?? false,
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
    if (!existing) throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);

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

  /**
   * Refuse a debit that would take a shop account below zero, unless the user
   * saw the warning and confirmed (`allowNegative`). The balance row is locked
   * so two payments entered at once can't both pass on the same starting
   * figure. The external account has no floor. Runs inside `tx`.
   */
  private async assertCoversTx(
    tx: DbTx,
    account: Account,
    currency: string,
    amount: number,
    allowNegative?: boolean,
  ): Promise<void> {
    if (allowNegative || account.type === 'external') return;
    const [row] = await tx
      .select({balance: accountBalances.balance})
      .from(accountBalances)
      .where(
        and(
          eq(accountBalances.accountId, account.id),
          eq(accountBalances.currency, currency),
        ),
      )
      .for('update')
      .limit(1);
    const balanceCents = Math.round(Number(row?.balance ?? 0) * 100);
    const shortCents = Math.round(amount * 100) - balanceCents;
    if (shortCents <= 0) return;
    throw new AppException(ErrorCode.FINANCE_INSUFFICIENT_BALANCE, {
      accountName: account.name,
      currency,
      balance: displayAmount(balanceCents / 100),
      shortfall: displayAmount(shortCents / 100),
      balanceValue: balanceCents / 100,
      shortfallValue: shortCents / 100,
    });
  }

  // The hidden account "Tashqi mablag'" pairs live on — one per business
  // (partial unique index), created on first use.
  private async getOrCreateExternalAccountTx(
    tx: DbTx,
    businessId: string,
  ): Promise<Account> {
    const find = () =>
      tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.businessId, businessId),
            eq(accounts.type, 'external'),
          ),
        )
        .limit(1);
    const [existing] = await find();
    if (existing) return existing;

    await tx
      .insert(accounts)
      .values({
        id: generateId(),
        businessId,
        name: EXTERNAL_ACCOUNT_NAME,
        type: 'external',
        isActive: true,
      })
      .onConflictDoNothing();
    const [created] = await find();
    return created;
  }

  // The capital income category the kirim leg of a pair is booked under.
  // Re-created on demand, like the payroll category, if it was renamed away.
  private async getOrCreateCapitalIncomeCategoryTx(
    tx: DbTx,
    businessId: string,
  ): Promise<FinancialCategory> {
    const base = and(
      eq(financialCategories.businessId, businessId),
      eq(financialCategories.kind, 'income'),
      eq(financialCategories.isCapital, true),
      eq(financialCategories.isActive, true),
    );
    const [named] = await tx
      .select()
      .from(financialCategories)
      .where(
        and(base, eq(financialCategories.name, CAPITAL_INCOME_CATEGORY_NAME)),
      )
      .limit(1);
    if (named) return named;
    const [any] = await tx
      .select()
      .from(financialCategories)
      .where(base)
      .orderBy(financialCategories.createdAt)
      .limit(1);
    if (any) return any;

    const [created] = await tx
      .insert(financialCategories)
      .values({
        id: generateId(),
        businessId,
        name: CAPITAL_INCOME_CATEGORY_NAME,
        kind: 'income',
        isCapital: true,
        isActive: true,
      })
      .returning();
    return created;
  }

  // Write one single-account ledger row and move its balance. Runs in `tx`.
  private async insertLegTx(
    tx: DbTx,
    businessId: string,
    account: Account,
    leg: {
      kind: 'income' | 'expense';
      source: FinanceSource;
      amount: number;
      currency: string;
      isCash?: boolean;
      categoryId?: string | null;
      categoryName?: string | null;
      cashierId?: string | null;
      cashierName?: string | null;
      note?: string | null;
      operationDate?: Date | null;
      pairId?: string | null;
    },
  ): Promise<FinancialTransaction> {
    const [txn] = await tx
      .insert(financialTransactions)
      .values({
        id: generateId(),
        businessId,
        kind: leg.kind,
        source: leg.source,
        accountId: account.id,
        accountName: account.name,
        isCash: leg.isCash ?? account.type === 'cash',
        amount: String(leg.amount),
        currency: leg.currency,
        categoryId: leg.categoryId ?? null,
        categoryName: leg.categoryName ?? null,
        cashierId: leg.cashierId ?? null,
        cashierName: leg.cashierName ?? null,
        note: leg.note ?? null,
        operationDate: leg.operationDate ?? null,
        pairId: leg.pairId ?? null,
      })
      .returning();

    await this.applyBalanceDelta(
      tx,
      businessId,
      account.id,
      leg.currency,
      leg.kind === 'income' ? leg.amount : -leg.amount,
    );
    return txn;
  }

  /**
   * Book money going out, inside the caller's transaction — the one path for
   * manual expenses, supplier payments and wages. From a shop account it
   * debits that account (refused below zero unless `allowNegative`). With
   * `external` the owner paid out of pocket: a capital kirim and the expense
   * are booked as a pair on the hidden external account, so shop balances
   * don't move, the owner's contribution grows, and the P&L still sees the
   * cost. Returns the expense leg.
   */
  async recordExpenseTx(
    tx: DbTx,
    businessId: string,
    params: FundingOptions & {
      source: FinanceSource;
      amount: number;
      currency: string;
      note?: string | null;
      categoryId?: string | null;
      categoryName?: string | null;
      cashierId?: string | null;
      cashierName?: string | null;
      operationDate?: Date | null;
      isCash?: boolean;
    },
  ): Promise<FinancialTransaction> {
    const leg = {
      source: params.source,
      amount: params.amount,
      currency: params.currency,
      categoryId: params.categoryId,
      categoryName: params.categoryName,
      cashierId: params.cashierId,
      cashierName: params.cashierName,
      note: params.note,
      operationDate: params.operationDate,
    };

    if (params.external) {
      const external = await this.getOrCreateExternalAccountTx(tx, businessId);
      const capital = await this.getOrCreateCapitalIncomeCategoryTx(
        tx,
        businessId,
      );
      const pairId = generateId();
      await this.insertLegTx(tx, businessId, external, {
        ...leg,
        kind: 'income',
        source: 'external',
        isCash: false,
        categoryId: capital.id,
        categoryName: capital.name,
        pairId,
      });
      return this.insertLegTx(tx, businessId, external, {
        ...leg,
        kind: 'expense',
        isCash: false,
        pairId,
      });
    }

    if (!params.accountId) {
      throw new AppException(ErrorCode.FINANCE_ACCOUNT_NOT_FOUND);
    }
    const account = await this.loadAccount(businessId, params.accountId, tx);
    await this.assertCoversTx(
      tx,
      account,
      params.currency,
      params.amount,
      params.allowNegative,
    );
    return this.insertLegTx(tx, businessId, account, {
      ...leg,
      kind: 'expense',
      isCash: params.isCash,
    });
  }

  // ─── Transactions (Tranzaksiyalar) ────────────────────────────────────────
  // A manual row's category must exist and be of the row's kind. A kirim
  // always needs one — its category is what says capital or profit.
  private async loadCategoryFor(
    businessId: string,
    kind: 'income' | 'expense',
    categoryId?: string,
  ): Promise<FinancialCategory | null> {
    if (!categoryId) {
      if (kind === 'income') {
        throw new AppException(ErrorCode.FINANCE_CATEGORY_REQUIRED);
      }
      return null;
    }
    const [cat] = await this.db
      .select()
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.id, categoryId),
          eq(financialCategories.businessId, businessId),
          eq(financialCategories.kind, kind),
        ),
      )
      .limit(1);
    if (!cat) throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);
    return cat;
  }

  async createIncome(
    businessId: string,
    dto: CreateTransactionDto,
    account?: IAccount,
  ): Promise<FinancialTransaction> {
    const category = await this.loadCategoryFor(
      businessId,
      'income',
      dto.categoryId,
    );
    if (!dto.accountId) {
      throw new AppException(ErrorCode.FINANCE_ACCOUNT_NOT_FOUND);
    }
    const target = await this.loadAccount(businessId, dto.accountId);
    const cashier = await this.resolveCashier(account);

    return this.db.transaction((tx) =>
      this.insertLegTx(tx, businessId, target, {
        kind: 'income',
        source: 'manual',
        amount: dto.amount,
        currency: dto.currency ?? 'UZS',
        isCash: dto.isCash,
        categoryId: category?.id,
        categoryName: category?.name,
        cashierId: cashier.id,
        cashierName: cashier.name,
        note: dto.note,
        operationDate: dto.operationDate ? new Date(dto.operationDate) : null,
      }),
    );
  }

  async createExpense(
    businessId: string,
    dto: CreateTransactionDto,
    account?: IAccount,
  ): Promise<FinancialTransaction> {
    const category = await this.loadCategoryFor(
      businessId,
      'expense',
      dto.categoryId,
    );
    const cashier = await this.resolveCashier(account);

    return this.db.transaction((tx) =>
      this.recordExpenseTx(tx, businessId, {
        source: 'manual',
        accountId: dto.accountId,
        external: dto.external,
        allowNegative: dto.allowNegative,
        amount: dto.amount,
        currency: dto.currency ?? 'UZS',
        isCash: dto.isCash,
        categoryId: category?.id,
        categoryName: category?.name,
        cashierId: cashier.id,
        cashierName: cashier.name,
        note: dto.note,
        operationDate: dto.operationDate ? new Date(dto.operationDate) : null,
      }),
    );
  }

  async createTransfer(
    businessId: string,
    dto: CreateTransferDto,
    account?: IAccount,
  ): Promise<FinancialTransaction> {
    if (dto.fromAccountId === dto.toAccountId) {
      throw new AppException(ErrorCode.FINANCE_TRANSFER_SAME_ACCOUNT);
    }
    const from = await this.loadAccount(businessId, dto.fromAccountId);
    const to = await this.loadAccount(businessId, dto.toAccountId);
    const cashier = await this.resolveCashier(account);
    const currency = dto.currency ?? 'UZS';
    const amount = dto.amount;

    return this.db.transaction(async (tx) => {
      await this.assertCoversTx(tx, from, currency, amount, dto.allowNegative);
      const [txn] = await tx
        .insert(financialTransactions)
        .values({
          id: generateId(),
          businessId,
          kind: 'transfer',
          source: 'manual',
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

  // ─── Storno (Bekor qilish) ────────────────────────────────────────────────
  /**
   * Answer a posted row — and its "Tashqi mablag'" partner, if it has one —
   * with reversal rows that move the money back, and mark the originals
   * cancelled. Nothing is deleted: the ledger keeps what happened and that it
   * was taken back, while reports skip both. Runs inside the caller's `tx`,
   * so a supplier-payment cancel or a payroll undo reverses its own row the
   * same way. `manualOnly` is the Moliya button: rows another module owns
   * must be cancelled there, or that module's own records would drift.
   */
  async reverseTx(
    tx: DbTx,
    businessId: string,
    transactionId: string,
    actor: {id: string | null; name: string | null},
    opts: {allowNegative?: boolean; manualOnly?: boolean} = {},
  ): Promise<FinancialTransaction[]> {
    const [first] = await tx
      .select()
      .from(financialTransactions)
      .where(
        and(
          eq(financialTransactions.id, transactionId),
          eq(financialTransactions.businessId, businessId),
        ),
      )
      .for('update')
      .limit(1);
    if (!first) throw new AppException(ErrorCode.FINANCE_TRANSACTION_NOT_FOUND);

    const legs = first.pairId
      ? await tx
          .select()
          .from(financialTransactions)
          .where(
            and(
              eq(financialTransactions.businessId, businessId),
              eq(financialTransactions.pairId, first.pairId),
            ),
          )
          .orderBy(financialTransactions.createdAt)
          .for('update')
      : [first];

    if (legs.some((l) => l.cancelledAt)) {
      throw new AppException(ErrorCode.FINANCE_TRANSACTION_ALREADY_CANCELLED);
    }
    const reversible = legs.every(
      (l) =>
        l.source !== 'reversal' &&
        ['income', 'expense', 'transfer'].includes(l.kind) &&
        l.accountId &&
        (!opts.manualOnly ||
          CANCELLABLE_SOURCES.includes(l.source as FinanceSource)),
    );
    if (!reversible) {
      throw new AppException(ErrorCode.FINANCE_TRANSACTION_NOT_CANCELLABLE);
    }

    const now = new Date();
    const reversals: FinancialTransaction[] = [];
    for (const leg of legs) {
      const amount = Number(leg.amount);
      // Taking back a kirim, or the far side of a transfer, is a debit.
      const debited =
        leg.kind === 'income'
          ? leg.accountId
          : leg.kind === 'transfer'
            ? leg.toAccountId
            : null;
      if (debited) {
        const [acc] = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.id, debited))
          .limit(1);
        if (acc) {
          await this.assertCoversTx(
            tx,
            acc,
            leg.currency,
            amount,
            opts.allowNegative,
          );
        }
      }

      const isTransfer = leg.kind === 'transfer';
      const note = `Bekor qilindi${leg.note ? `: ${leg.note}` : ''}`.slice(
        0,
        500,
      );
      const [rev] = await tx
        .insert(financialTransactions)
        .values({
          id: generateId(),
          businessId,
          kind: isTransfer
            ? 'transfer'
            : leg.kind === 'income'
              ? 'expense'
              : 'income',
          source: 'reversal',
          reversesId: leg.id,
          accountId: isTransfer ? leg.toAccountId : leg.accountId,
          accountName: isTransfer ? leg.toAccountName : leg.accountName,
          toAccountId: isTransfer ? leg.accountId : null,
          toAccountName: isTransfer ? leg.accountName : null,
          isCash: leg.isCash,
          amount: leg.amount,
          currency: leg.currency,
          categoryId: leg.categoryId,
          categoryName: leg.categoryName,
          cashierId: actor.id,
          cashierName: actor.name,
          note,
        })
        .returning();
      reversals.push(rev);

      if (isTransfer) {
        await this.applyBalanceDelta(
          tx,
          businessId,
          leg.accountId!,
          leg.currency,
          amount,
        );
        if (leg.toAccountId) {
          await this.applyBalanceDelta(
            tx,
            businessId,
            leg.toAccountId,
            leg.currency,
            -amount,
          );
        }
      } else {
        await this.applyBalanceDelta(
          tx,
          businessId,
          leg.accountId!,
          leg.currency,
          leg.kind === 'income' ? -amount : amount,
        );
      }

      await tx
        .update(financialTransactions)
        .set({cancelledAt: now})
        .where(eq(financialTransactions.id, leg.id));
    }
    return reversals;
  }

  /** The Moliya "Bekor qilish" button — manual rows only. */
  async cancelTransaction(
    businessId: string,
    transactionId: string,
    dto: CancelTransactionDto,
    account?: IAccount,
  ): Promise<FinancialTransaction[]> {
    const cashier = await this.resolveCashier(account);
    return this.db.transaction((tx) =>
      this.reverseTx(tx, businessId, transactionId, cashier, {
        allowNegative: dto.allowNegative,
        manualOnly: true,
      }),
    );
  }

  // ─── Capital (Ta'sischi kiritmasi) ────────────────────────────────────────
  /**
   * What the owner has put into the business and taken out of it, per
   * currency: capital-category kirims (incl. every "Tashqi mablag'" payment)
   * against capital-category outflows such as inkassatsiya.
   */
  async getCapitalSummary(businessId: string): Promise<{
    currencies: Array<{
      currency: string;
      contributed: number;
      withdrawn: number;
      net: number;
    }>;
  }> {
    const rows = await this.db
      .select({
        currency: financialTransactions.currency,
        contributed: sql<string>`COALESCE(SUM(CASE WHEN ${financialTransactions.kind} = 'income' THEN ${financialTransactions.amount} ELSE 0 END), 0)`,
        withdrawn: sql<string>`COALESCE(SUM(CASE WHEN ${financialTransactions.kind} = 'expense' THEN ${financialTransactions.amount} ELSE 0 END), 0)`,
      })
      .from(financialTransactions)
      .leftJoin(
        financialCategories,
        eq(financialCategories.id, financialTransactions.categoryId),
      )
      .where(
        and(
          eq(financialTransactions.businessId, businessId),
          inArray(financialTransactions.kind, ['income', 'expense']),
          liveRow(),
          capitalRow(),
        ),
      )
      .groupBy(financialTransactions.currency);

    return {
      currencies: rows.map((r) => {
        const contributed = Number(r.contributed);
        const withdrawn = Number(r.withdrawn);
        return {
          currency: r.currency,
          contributed,
          withdrawn,
          net: contributed - withdrawn,
        };
      }),
    };
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
        gte(financialTransactions.createdAt, businessDayStart(query.from)),
      );
    if (query.to)
      conditions.push(
        lte(financialTransactions.createdAt, businessDayEnd(query.to)),
      );

    const where = and(...conditions);

    // Totals skip stornoed rows and the storno rows themselves — a cancelled
    // kirim must not still read as money in.
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
        .where(and(where, liveRow()))
        .groupBy(financialTransactions.kind, financialTransactions.currency),
    ]);

    // A pair is cancellable only as a whole, so look at both legs' sources.
    const pairIds = [
      ...new Set(rows.map((r) => r.pairId).filter((id): id is string => !!id)),
    ];
    const pairLegs = pairIds.length
      ? await this.db
          .select({
            pairId: financialTransactions.pairId,
            source: financialTransactions.source,
          })
          .from(financialTransactions)
          .where(
            and(
              eq(financialTransactions.businessId, businessId),
              inArray(financialTransactions.pairId, pairIds),
            ),
          )
      : [];
    const systemPairs = new Set(
      pairLegs
        .filter((l) => !CANCELLABLE_SOURCES.includes(l.source as FinanceSource))
        .map((l) => l.pairId),
    );
    const cancellable = (r: FinancialTransaction) =>
      !r.cancelledAt &&
      CANCELLABLE_SOURCES.includes(r.source as FinanceSource) &&
      ['income', 'expense', 'transfer'].includes(r.kind) &&
      !(r.pairId && systemPairs.has(r.pairId));

    return {
      transactions: rows.map((r) => ({...r, cancellable: cancellable(r)})),
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
      source: 'cash_movement',
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

    if (saleTotals.cashSales !== 0) {
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
        source: 'shift_close',
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

    if (saleTotals.cardSales !== 0) {
      const bankAccount = await this.getOrCreateNoncashAccountTx(
        tx,
        businessId,
      );
      await tx.insert(financialTransactions).values({
        id: generateId(),
        businessId,
        kind: 'shift_close',
        source: 'shift_close',
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
