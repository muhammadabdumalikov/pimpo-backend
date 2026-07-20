import {Injectable, Inject} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {
  eq,
  and,
  desc,
  ilike,
  or,
  count,
  sql,
  gte,
  lte,
  inArray,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {CacheKeys, TTL} from '../cache/cache.util';
import {isStockTakeActive} from '../common/stock-take-lock';
import {businessDayStart, businessDayEnd} from '../common/business-time';
import {
  orders,
  orderItems,
  products,
  branchStock,
  categories,
  users,
  userDebts,
  receiptSettings,
  staff,
  businesses,
  cashShifts,
  cashRegisters,
  type Order,
  type OrderItem,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {UserService} from '../user/user.service';
import {SubscriptionService} from '../subscription/subscription.service';
import {BranchService} from '../branch/branch.service';
import {CreateOrderDto} from './dto/create-order.dto';
import {HoldOrderDto} from './dto/hold-order.dto';
import {UpdateOrderDto} from './dto/update-order.dto';
import {IAccount} from '../business/types';
import {consumeBatches, type CostingMethod} from './costing';

export type OrderWithItems = Order & {items: OrderItem[]};

// Per-order outcome for a batch (offline-sync) create. Errors are captured per
// order so one rejected sale doesn't fail the others.
export interface BatchOrderResult {
  clientId: string | null;
  status: 'ok' | 'error';
  orderId?: string;
  error?: string;
}

function money(value: number): string {
  return value.toFixed(2);
}

// Postgres unique-violation SQLSTATE. Raised when two concurrent retries of the
// same offline sale race on the (business_id, client_id) index.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as {code?: string}).code === '23505'
  );
}

@Injectable()
export class OrderService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly userService: UserService,
    private readonly subscriptionService: SubscriptionService,
    private readonly branchService: BranchService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // Resolve the branch a sale belongs to: an explicit branch from the client,
  // else the business default branch (created on first use). Enables per-store
  // reporting; today checkout is single-branch so this is the default branch.
  private async resolveBranchId(
    businessId: string,
    explicit?: string,
  ): Promise<string> {
    if (explicit) return explicit;
    return (await this.branchService.ensureDefault(businessId)).id;
  }

  // The branch a sale draws stock from: an explicit branch, else the branch of
  // the register the shift is on, else the default branch. This is what makes a
  // sale deplete the right store's stock.
  private async resolveSaleBranch(
    businessId: string,
    explicit: string | undefined,
    shiftId: string | null,
  ): Promise<string> {
    if (explicit) return explicit;
    if (shiftId) {
      const [row] = await this.dbService.db
        .select({branchId: cashRegisters.branchId})
        .from(cashShifts)
        .innerJoin(cashRegisters, eq(cashShifts.registerId, cashRegisters.id))
        .where(
          and(
            eq(cashShifts.id, shiftId),
            eq(cashShifts.businessId, businessId),
          ),
        )
        .limit(1);
      if (row?.branchId) return row.branchId;
    }
    return (await this.branchService.ensureDefault(businessId)).id;
  }

  // Resolve the acting account into a snapshotted cashier (id + display name).
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

  // Resolve which cashier shift an admin sale belongs to, enforcing the "a shift
  // must be open" rule. Returns the shift id to stamp on the order.
  //   - An offline sale may carry the exact `shiftId` it was rung under; we trust
  //     it (after verifying it belongs to the business) so a post-sync close race
  //     doesn't reject an already-completed sale.
  //   - Otherwise we pick the register (explicit `registerId`, or the business's
  //     sole register) and require it to have an open shift; if none, the sale is
  //     blocked with a clear message.
  private async resolveShiftForSale(
    businessId: string,
    dto: CreateOrderDto,
  ): Promise<string> {
    if (dto.shiftId) {
      const [shift] = await this.dbService.db
        .select({id: cashShifts.id})
        .from(cashShifts)
        .where(
          and(
            eq(cashShifts.id, dto.shiftId),
            eq(cashShifts.businessId, businessId),
          ),
        )
        .limit(1);
      if (!shift) {
        throw new AppException(ErrorCode.SHIFT_NOT_FOUND_FOR_BUSINESS);
      }
      return shift.id;
    }

    // Pick the register: explicit, or the only active one.
    let registerId = dto.registerId ?? null;
    if (!registerId) {
      const activeRegisters = await this.dbService.db
        .select({id: cashRegisters.id})
        .from(cashRegisters)
        .where(
          and(
            eq(cashRegisters.businessId, businessId),
            eq(cashRegisters.isActive, true),
          ),
        )
        .limit(2);
      if (activeRegisters.length === 1) {
        registerId = activeRegisters[0].id;
      } else if (activeRegisters.length === 0) {
        throw new AppException(ErrorCode.NO_CASH_REGISTER);
      } else {
        throw new AppException(ErrorCode.MULTIPLE_REGISTERS);
      }
    }

    const [openShift] = await this.dbService.db
      .select({id: cashShifts.id})
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.businessId, businessId),
          eq(cashShifts.registerId, registerId),
          eq(cashShifts.status, 'open'),
        ),
      )
      .limit(1);
    if (!openShift) {
      throw new AppException(ErrorCode.NO_OPEN_SHIFT_FOR_REGISTER);
    }
    return openShift.id;
  }

  // Blocks a sale when an inventory count is in progress. Cache-aside read
  // (in-memory flag, DB as source of truth) so the hot checkout path avoids a
  // query on every sale; fail-open if the stock_takes table isn't migrated yet.
  private async assertNoStockTakeInProgress(businessId: string): Promise<void> {
    if (await isStockTakeActive(this.cache, this.dbService.db, businessId)) {
      throw new AppException(ErrorCode.SALES_FROZEN_STOCK_TAKE);
    }
  }

  async create(
    businessId: string,
    dto: CreateOrderDto,
    account?: IAccount,
  ): Promise<OrderWithItems> {
    // Idempotency: an offline sale may be re-sent from the client's outbox over
    // a flaky connection. If this clientId was already stored, return that order
    // instead of ringing up a duplicate. The unique index is the real guard
    // (see the catch below); this is just the fast path for a settled retry.
    if (dto.clientId) {
      const existing = await this.findByClientId(businessId, dto.clientId);
      if (existing) return existing;
    }

    // Freeze sales while a stock-take is open — the count relies on a stable
    // book-quantity snapshot (INVENTARIZATSIYA.md §9.4). Guarded + fail-open so
    // a store never gets stuck if the stock_takes table isn't migrated yet.
    await this.assertNoStockTakeInProgress(businessId);

    const isDebt = dto.paymentMethod === 'debt';
    const cashier = await this.resolveCashier(account);

    // Admin sales must be rung up against an open cash shift (store/guest sales
    // have no cashier and are exempt). This blocks selling with no shift open.
    const isStoreSale = (dto.source ?? 'admin') === 'store';
    const shiftId = isStoreSale
      ? null
      : await this.resolveShiftForSale(businessId, dto);

    // Resolve optional customer.
    let customerName = dto.customerName ?? null;
    let customerId: string | null = dto.userId ?? null;
    if (dto.userId) {
      const [user] = await this.dbService.db
        .select()
        .from(users)
        .where(and(eq(users.businessId, businessId), eq(users.id, dto.userId)))
        .limit(1);
      if (!user) {
        throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND);
      }
      if (!customerName) customerName = user.name;
    }

    // A debt sale ("give on credit") must be tied to a real customer so we can
    // track who owes what, for which order. The due date is optional.
    if (isDebt) {
      // Respect the plan's debt limit (same rule as the standalone debt page).
      const {debtsLimit} =
        await this.subscriptionService.getSubscriptionLimits(businessId);
      if (debtsLimit !== null) {
        const [{value: debtCount}] = await this.dbService.db
          .select({value: count()})
          .from(userDebts)
          .where(eq(userDebts.businessId, businessId));
        if (debtCount >= debtsLimit) {
          throw new AppException(ErrorCode.DEBT_LIMIT_REACHED, {
            limit: debtsLimit,
          });
        }
      }
      // Resolve the customer: existing id, or find-or-create by name + phone.
      if (!customerId) {
        if (!customerName || !dto.phone) {
          throw new AppException(ErrorCode.DEBT_SALE_CUSTOMER_REQUIRED);
        }
        const existing = await this.userService.findByPhone(
          businessId,
          dto.phone,
        );
        const user =
          existing ??
          (await this.userService.create(businessId, {
            name: customerName,
            phone: dto.phone,
          }));
        customerId = user.id;
        if (!customerName) customerName = user.name;
      }
    }

    // Validate + snapshot each product. Cost and revenue are valued from the
    // inventory batches inside the transaction below (selling price is per
    // batch), so here we only capture each product's id/name and its current
    // priceIn/priceOut to use as the oversell fallback.
    const planned: {
      productId: string;
      productName: string;
      priceIn: number;
      priceOut: number;
      quantity: number;
      // Resolved tier: 'unit' prices per batch; 'wholesale'/'bundle' flat-price
      // the whole line at priceOverride.
      priceType: 'unit' | 'wholesale' | 'bundle';
      priceOverride: number | null;
    }[] = [];
    let itemCount = 0;

    for (const item of dto.items) {
      const [product] = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.id, item.productId),
          ),
        )
        .limit(1);
      if (!product) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
          productId: item.productId,
        });
      }
      // Resolve the requested price tier to the product's configured price. An
      // unset/unknown tier — or a tier the product hasn't priced — falls back to
      // unit (per-batch) pricing, so the client can never dictate a raw amount.
      let priceType: 'unit' | 'wholesale' | 'bundle' = 'unit';
      let priceOverride: number | null = null;
      if (item.priceTier === 'wholesale' && product.priceWholesale != null) {
        priceType = 'wholesale';
        priceOverride = Number(product.priceWholesale);
      } else if (item.priceTier === 'bundle' && product.priceBundle != null) {
        priceType = 'bundle';
        priceOverride = Number(product.priceBundle);
      }
      planned.push({
        productId: product.id,
        productName: product.name,
        priceIn: Number(product.priceIn),
        priceOut: Number(product.priceOut),
        quantity: item.quantity,
        priceType,
        priceOverride,
      });
      // Weighed goods count as one item (their fractional kg isn't a piece
      // count), so itemCount stays a whole number for the integer column.
      itemCount += product.quantityType === 'kg' ? 1 : item.quantity;
    }

    // VAT (QQS, inclusive) + costing method come from the business settings.
    const [settings] = await this.dbService.db
      .select({
        vatEnabled: receiptSettings.vatEnabled,
        vatRate: receiptSettings.vatRate,
        costingMethod: receiptSettings.costingMethod,
      })
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);
    const vatEnabled = settings?.vatEnabled ?? false;
    const vatRate = vatEnabled ? Number(settings?.vatRate ?? 0) : 0;
    const method: CostingMethod =
      settings?.costingMethod === 'FIFO' ? 'FIFO' : 'AVERAGE';

    const orderId = generateId();
    const branchId = await this.resolveSaleBranch(
      businessId,
      dto.branchId,
      shiftId,
    );

    try {
      await this.dbService.db.transaction(async (tx) => {
        // Value each line against the FIFO batch queue (locks batches FOR UPDATE),
        // producing the COGS + batch-priced revenue snapshot. `total` is the sum of
        // the real per-batch revenue, so it must be computed here, before payments.
        const lines: {
          productId: string;
          productName: string;
          priceOut: string;
          priceType: string;
          quantity: number;
          lineTotal: string;
          costIn: string;
          costTotal: string;
          frontPriceOut: string | null;
        }[] = [];
        let total = 0;

        for (const p of planned) {
          const c = await consumeBatches(
            tx,
            businessId,
            p.productId,
            p.quantity,
            method,
            p.priceIn,
            p.priceOut,
            branchId, // draw from the sale's branch lots
            p.priceOverride,
          );
          total += c.revenueTotal;
          lines.push({
            productId: p.productId,
            productName: p.productName,
            priceOut: money(c.priceOut),
            priceType: p.priceType,
            quantity: p.quantity,
            lineTotal: money(c.revenueTotal),
            costIn: money(c.costIn),
            costTotal: money(c.costTotal),
            frontPriceOut: c.frontPriceOut,
          });
        }

        // Apply the manual whole-receipt discount (fixed soʻm or percent) to the
        // gross subtotal. COGS is untouched, so profit = discounted revenue - cost.
        // Everything below (payments, VAT, debt, totalAmount) keys off the net total.
        const subtotal = total;
        let discountType: string | null = null;
        let discountValue: number | null = null;
        let discountAmount = 0;
        if (dto.discountType && dto.discountValue && dto.discountValue > 0) {
          discountType = dto.discountType;
          discountValue = dto.discountValue;
          const raw =
            dto.discountType === 'percent'
              ? (subtotal * Math.min(dto.discountValue, 100)) / 100
              : dto.discountValue;
          discountAmount = Math.max(0, Math.min(raw, subtotal));
        }
        total = subtotal - discountAmount;

        // Resolve the payment breakdown against the batch-priced total.
        let payments: {method: string; amount: number}[];
        let paymentMethod: string | null;
        let amountPaid: number;
        let changeAmount: number;
        // For a debt sale this is the unpaid remainder owed by the customer.
        let debtAmount = 0;

        if (isDebt) {
          // `payments` here is what the customer pays *now* (a down payment); the
          // rest becomes the debt. An empty list means the whole total is owed.
          payments = (dto.payments ?? []).map((p) => ({
            method: p.method,
            amount: p.amount,
          }));
          const paidNow = payments.reduce((sum, p) => sum + p.amount, 0);
          debtAmount = Math.max(0, total - paidNow);
          paymentMethod = 'debt';
          const cashApplied = payments
            .filter((p) => p.method === 'cash')
            .reduce((sum, p) => sum + p.amount, 0);
          amountPaid = dto.amountPaid ?? cashApplied;
          changeAmount = 0;
        } else {
          // Default to a single method covering the whole total.
          payments =
            dto.payments && dto.payments.length > 0
              ? dto.payments.map((p) => ({method: p.method, amount: p.amount}))
              : [{method: dto.paymentMethod ?? 'cash', amount: total}];
          const methods = Array.from(new Set(payments.map((p) => p.method)));
          paymentMethod =
            methods.length > 1
              ? 'split'
              : (methods[0] ?? dto.paymentMethod ?? null);
          // Cash tendered (defaults to the total); change is over the cash portion.
          const cashApplied = payments
            .filter((p) => p.method === 'cash')
            .reduce((sum, p) => sum + p.amount, 0);
          amountPaid = dto.amountPaid ?? cashApplied;
          changeAmount = Math.max(0, amountPaid - cashApplied);
        }

        const taxAmount = vatRate > 0 ? (total * vatRate) / (100 + vatRate) : 0;

        await tx.insert(orders).values({
          id: orderId,
          businessId,
          clientId: dto.clientId ?? null,
          userId: customerId,
          customerName,
          status: dto.status ?? 'Pending',
          totalAmount: money(total),
          subtotalAmount: money(subtotal),
          discountType,
          discountValue: discountValue !== null ? money(discountValue) : null,
          discountAmount: money(discountAmount),
          itemCount,
          paymentMethod,
          payments,
          amountPaid: money(amountPaid),
          changeAmount: money(changeAmount),
          taxRate: money(vatRate),
          taxAmount: money(taxAmount),
          note: dto.note ?? null,
          source: dto.source ?? 'admin',
          cashierId: cashier.id,
          cashierName: cashier.name,
          shiftId,
          branchId,
        });

        await tx.insert(orderItems).values(
          lines.map((line) => ({
            id: generateId(),
            orderId,
            businessId,
            productId: line.productId,
            productName: line.productName,
            priceOut: line.priceOut,
            priceType: line.priceType,
            quantity: line.quantity,
            lineTotal: line.lineTotal,
            costIn: line.costIn,
            costTotal: line.costTotal,
          })),
        );

        // Draw the sold qty from the sale's BRANCH stock, keep products.quantity
        // (the cross-branch sum) in step, and track the displayed selling price
        // to the new FIFO-front batch (the next unit to be sold).
        for (const line of lines) {
          await tx
            .insert(branchStock)
            .values({
              id: generateId(),
              businessId,
              productId: line.productId,
              branchId,
              quantity: -line.quantity,
            })
            .onConflictDoUpdate({
              target: [branchStock.productId, branchStock.branchId],
              set: {
                quantity: sql`ROUND((${branchStock.quantity} - ${line.quantity})::numeric, 3)`,
                updatedAt: new Date(),
              },
            });
          await tx
            .update(products)
            .set({
              quantity: sql`ROUND((${products.quantity} - ${line.quantity})::numeric, 3)`,
              ...(line.frontPriceOut !== null
                ? {priceOut: line.frontPriceOut}
                : {}),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(products.businessId, businessId),
                eq(products.id, line.productId),
              ),
            );
        }

        // Completing a resumed held sale: drop the parked order in the same
        // transaction so it can't be resumed or completed twice. Held orders
        // never touched stock, so a hard delete is safe.
        if (dto.heldOrderId) {
          await tx
            .delete(orders)
            .where(
              and(
                eq(orders.businessId, businessId),
                eq(orders.id, dto.heldOrderId),
                eq(orders.status, 'Held'),
              ),
            );
        }

        // Debt sale: record the unpaid remainder as a credit, linked to this
        // order + customer. (Skip if a down payment covered the whole total.)
        if (isDebt && customerId && debtAmount > 0) {
          const itemSummary = lines
            .map((l) => `${l.productName} ×${l.quantity}`)
            .join(', ');
          await tx.insert(userDebts).values({
            id: generateId(),
            businessId,
            userId: customerId,
            orderId,
            amount: money(debtAmount),
            status: 'Pending',
            dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
            description: itemSummary.slice(0, 500),
          });
        }
      });
    } catch (err) {
      // A concurrent retry of the same offline sale lost the race on the unique
      // (business_id, client_id) index. Return the order that won, not an error.
      if (dto.clientId && isUniqueViolation(err)) {
        const existing = await this.findByClientId(businessId, dto.clientId);
        if (existing) return existing;
      }
      throw err;
    }

    return this.findOne(businessId, orderId) as Promise<OrderWithItems>;
  }

  /**
   * Park the current cart as a held ("kechiktirilgan") sale. A held order is
   * just a saved cart: stock is NOT decremented, no inventory batches are
   * consumed and no payment/debt/kassa records are written — its totals are a
   * display snapshot from the products' current selling prices. Completing it
   * later goes back through create() with `heldOrderId`, which rings up a
   * fresh (properly costed) order and deletes the parked one in the same
   * transaction.
   */
  async hold(
    businessId: string,
    dto: HoldOrderDto,
    account?: IAccount,
  ): Promise<OrderWithItems> {
    const cashier = await this.resolveCashier(account);

    // Resolve optional customer (same rule as a normal sale).
    let customerName = dto.customerName ?? null;
    const customerId: string | null = dto.userId ?? null;
    if (dto.userId) {
      const [user] = await this.dbService.db
        .select()
        .from(users)
        .where(and(eq(users.businessId, businessId), eq(users.id, dto.userId)))
        .limit(1);
      if (!user) {
        throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND);
      }
      if (!customerName) customerName = user.name;
    }

    // Snapshot each product at the chosen tier's selling price so resuming the
    // parked cart restores the same prices.
    const lines: {
      productId: string;
      productName: string;
      priceOut: string;
      priceType: string;
      quantity: number;
      lineTotal: string;
    }[] = [];
    let subtotal = 0;
    let itemCount = 0;
    for (const item of dto.items) {
      const [product] = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.id, item.productId),
          ),
        )
        .limit(1);
      if (!product) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
          productId: item.productId,
        });
      }
      // Same tier resolution as a completed sale (see create()): unknown/unpriced
      // tiers fall back to the unit price.
      let priceType: 'unit' | 'wholesale' | 'bundle' = 'unit';
      let priceOut = Number(product.priceOut);
      if (item.priceTier === 'wholesale' && product.priceWholesale != null) {
        priceType = 'wholesale';
        priceOut = Number(product.priceWholesale);
      } else if (item.priceTier === 'bundle' && product.priceBundle != null) {
        priceType = 'bundle';
        priceOut = Number(product.priceBundle);
      }
      const lineTotal = priceOut * item.quantity;
      subtotal += lineTotal;
      // Weighed goods count as one item (their fractional kg isn't a piece
      // count), so itemCount stays a whole number for the integer column.
      itemCount += product.quantityType === 'kg' ? 1 : item.quantity;
      lines.push({
        productId: product.id,
        productName: product.name,
        priceOut: money(priceOut),
        priceType,
        quantity: item.quantity,
        lineTotal: money(lineTotal),
      });
    }

    // The manual discount travels with the parked cart so resuming restores it.
    let discountType: string | null = null;
    let discountValue: number | null = null;
    let discountAmount = 0;
    if (dto.discountType && dto.discountValue && dto.discountValue > 0) {
      discountType = dto.discountType;
      discountValue = dto.discountValue;
      const raw =
        dto.discountType === 'percent'
          ? (subtotal * Math.min(dto.discountValue, 100)) / 100
          : dto.discountValue;
      discountAmount = Math.max(0, Math.min(raw, subtotal));
    }
    const total = subtotal - discountAmount;

    const branchId = await this.resolveBranchId(businessId, dto.branchId);

    // Auto-save upsert: if a live Held draft id is supplied, update it IN PLACE
    // (one stable draft, no id churn as the cart is auto-saved on every change);
    // otherwise create a new draft. A stale/retired id falls through to create.
    let targetId = dto.id ?? null;
    if (targetId) {
      const [existing] = await this.dbService.db
        .select({status: orders.status})
        .from(orders)
        .where(and(eq(orders.businessId, businessId), eq(orders.id, targetId)))
        .limit(1);
      if (!existing || existing.status !== 'Held') targetId = null;
    }
    const orderId = targetId ?? generateId();

    // Cart snapshot + rolled totals shared by both the insert and update paths.
    const snapshot = {
      userId: customerId,
      customerName,
      status: 'Held' as const,
      totalAmount: money(total),
      subtotalAmount: money(subtotal),
      discountType,
      discountValue: discountValue !== null ? money(discountValue) : null,
      discountAmount: money(discountAmount),
      itemCount,
      note: dto.note ?? null,
      branchId,
    };

    await this.dbService.db.transaction(async (tx) => {
      if (targetId) {
        // Update the existing draft's snapshot and replace its lines. Provenance
        // (cashier/source/shift) is left as first parked.
        await tx
          .update(orders)
          .set({...snapshot, updatedAt: new Date()})
          .where(
            and(eq(orders.businessId, businessId), eq(orders.id, orderId)),
          );
        await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
      } else {
        await tx.insert(orders).values({
          id: orderId,
          businessId,
          ...snapshot,
          paymentMethod: null,
          payments: [],
          amountPaid: money(0),
          changeAmount: money(0),
          taxRate: money(0),
          taxAmount: money(0),
          source: 'admin',
          cashierId: cashier.id,
          cashierName: cashier.name,
          shiftId: null,
        });
      }
      await tx.insert(orderItems).values(
        lines.map((line) => ({
          id: generateId(),
          orderId,
          businessId,
          productId: line.productId,
          productName: line.productName,
          priceOut: line.priceOut,
          priceType: line.priceType,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
          costIn: money(0),
          costTotal: money(0),
        })),
      );
    });

    return this.findOne(businessId, orderId) as Promise<OrderWithItems>;
  }

  /** Look up an order by its client-supplied idempotency key (with items). */
  async findByClientId(
    businessId: string,
    clientId: string,
  ): Promise<OrderWithItems | null> {
    const [order] = await this.dbService.db
      .select()
      .from(orders)
      .where(
        and(eq(orders.businessId, businessId), eq(orders.clientId, clientId)),
      )
      .limit(1);
    if (!order) return null;

    const items = await this.dbService.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    return {...order, items};
  }

  /**
   * Bulk-create queued offline orders in one request. Each order is created
   * independently (its own transaction) and idempotently on clientId, so a
   * single rejected sale is reported as an error without blocking the rest.
   * Processed serially to avoid stock/batch contention between orders.
   */
  async createBatch(
    businessId: string,
    orders: CreateOrderDto[],
    account?: IAccount,
  ): Promise<{results: BatchOrderResult[]}> {
    const results: BatchOrderResult[] = [];
    for (const dto of orders) {
      try {
        const order = await this.create(businessId, dto, account);
        results.push({
          clientId: dto.clientId ?? null,
          status: 'ok',
          orderId: order.id,
        });
      } catch (err) {
        results.push({
          clientId: dto.clientId ?? null,
          status: 'error',
          error: (err as Error)?.message ?? 'Failed to create order',
        });
      }
    }
    return {results};
  }

  /**
   * Public storefront checkout: there is no authenticated business, so the
   * owning business is derived from the first product, and all items must
   * belong to it (enforced by create()'s per-product business check).
   */
  async createStore(dto: CreateOrderDto): Promise<OrderWithItems> {
    const firstId = dto.items[0]?.productId;
    if (!firstId) {
      throw new AppException(ErrorCode.ORDER_EMPTY);
    }
    const [product] = await this.dbService.db
      .select({businessId: products.businessId})
      .from(products)
      .where(eq(products.id, firstId))
      .limit(1);
    if (!product) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
        productId: firstId,
      });
    }
    return this.create(product.businessId, {
      ...dto,
      userId: undefined,
      status: 'Pending',
      source: 'store',
    });
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      from?: string;
      to?: string;
      paymentMethod?: string;
      cashierId?: string;
      minAmount?: number;
      maxAmount?: number;
    },
  ): Promise<{orders: Order[]; total: number; page: number; limit: number}> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;

    const where = [eq(orders.businessId, businessId)];
    if (options?.status) {
      where.push(eq(orders.status, options.status));
    }
    if (options?.from) {
      where.push(gte(orders.createdAt, businessDayStart(options.from)));
    }
    if (options?.to) {
      // Include the whole "to" day (business-local).
      where.push(lte(orders.createdAt, businessDayEnd(options.to)));
    }
    if (options?.paymentMethod) {
      where.push(eq(orders.paymentMethod, options.paymentMethod));
    }
    if (options?.cashierId) {
      where.push(eq(orders.cashierId, options.cashierId));
    }
    if (options?.minAmount != null) {
      where.push(gte(orders.totalAmount, money(options.minAmount)));
    }
    if (options?.maxAmount != null) {
      where.push(lte(orders.totalAmount, money(options.maxAmount)));
    }
    if (options?.search) {
      where.push(
        or(
          ilike(orders.customerName, `%${options.search}%`),
          ilike(orders.id, `%${options.search}%`),
          ilike(orders.cashierName, `%${options.search}%`),
        )!,
      );
    }

    const totalResult = await this.dbService.db
      .select({count: count()})
      .from(orders)
      .where(and(...where));

    const rows = await this.dbService.db
      .select()
      .from(orders)
      .where(and(...where))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);

    // Distinct-product ("tur") count per order — the number of line items, not
    // the summed quantity. Fetched in one grouped query for the whole page.
    const ids = rows.map((r) => r.id);
    const typeCounts = new Map<string, number>();
    if (ids.length > 0) {
      const counts = await this.dbService.db
        .select({orderId: orderItems.orderId, types: count()})
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids))
        .groupBy(orderItems.orderId);
      for (const c of counts) typeCounts.set(c.orderId, Number(c.types));
    }
    const withTypes = rows.map((r) => ({
      ...r,
      itemTypes: typeCounts.get(r.id) ?? 0,
    }));

    return {orders: withTypes, total: totalResult[0].count, page, limit};
  }

  async findOne(
    businessId: string,
    id: string,
  ): Promise<OrderWithItems | null> {
    const [order] = await this.dbService.db
      .select()
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)))
      .limit(1);
    if (!order) return null;

    const items = await this.dbService.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    return {...order, items};
  }

  async findByUser(businessId: string, userId: string): Promise<Order[]> {
    return this.dbService.db
      .select()
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.userId, userId)))
      .orderBy(desc(orders.createdAt));
  }

  async updateStatus(
    businessId: string,
    id: string,
    status: string,
  ): Promise<OrderWithItems> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    }
    // A held sale never decremented stock, so promoting it here would create a
    // sale that no inventory ever backed. It must be completed via checkout.
    if (existing.status === 'Held' && status !== 'Cancelled') {
      throw new AppException(ErrorCode.HELD_SALE_CHECKOUT_REQUIRED);
    }
    await this.dbService.db
      .update(orders)
      .set({status, updatedAt: new Date()})
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)));
    return this.findOne(businessId, id) as Promise<OrderWithItems>;
  }

  /**
   * Edit a sale's metadata (date, customer, cashier, note). Money, items and
   * stock are untouched — those flows go through create/refund, not here.
   */
  async update(
    businessId: string,
    id: string,
    dto: UpdateOrderDto,
  ): Promise<OrderWithItems> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    }

    const patch: Partial<typeof orders.$inferInsert> = {updatedAt: new Date()};

    if (dto.note !== undefined) {
      patch.note = dto.note;
    }

    if (dto.userId !== undefined) {
      // The debt record is tied to the customer — changing it here would
      // desync who owes the money.
      if (existing.paymentMethod === 'debt') {
        throw new AppException(ErrorCode.DEBT_SALE_CUSTOMER_IMMUTABLE);
      }
      if (dto.userId === null) {
        patch.userId = null;
        patch.customerName = dto.customerName ?? null;
      } else {
        const [user] = await this.dbService.db
          .select()
          .from(users)
          .where(
            and(eq(users.businessId, businessId), eq(users.id, dto.userId)),
          )
          .limit(1);
        if (!user) {
          throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND);
        }
        patch.userId = user.id;
        patch.customerName = dto.customerName ?? user.name;
      }
    } else if (dto.customerName !== undefined) {
      patch.customerName = dto.customerName;
    }

    if (dto.cashierId !== undefined) {
      if (dto.cashierId === null) {
        patch.cashierId = null;
        patch.cashierName = null;
      } else {
        // A cashier is either a staff member or the owner (business) account.
        const [st] = await this.dbService.db
          .select({name: staff.name})
          .from(staff)
          .where(
            and(eq(staff.id, dto.cashierId), eq(staff.businessId, businessId)),
          )
          .limit(1);
        if (st) {
          patch.cashierId = dto.cashierId;
          patch.cashierName = st.name;
        } else if (dto.cashierId === businessId) {
          const [biz] = await this.dbService.db
            .select({name: businesses.name})
            .from(businesses)
            .where(eq(businesses.id, businessId))
            .limit(1);
          patch.cashierId = dto.cashierId;
          patch.cashierName = biz?.name ?? null;
        } else {
          throw new AppException(ErrorCode.CASHIER_NOT_FOUND);
        }
      }
    }

    await this.dbService.db
      .update(orders)
      .set(patch)
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)));
    return this.findOne(businessId, id) as Promise<OrderWithItems>;
  }

  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOne(businessId, id);
    if (!existing) {
      throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    }
    await this.dbService.db
      .delete(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)));
  }

  /**
   * Daily/ranged sales summary for the "All sales" screen: transaction count,
   * units sold, revenue, the received-money split by method (from the payments
   * jsonb — what was actually taken now), and the outstanding debt created in
   * the range (debt orders' totals minus their down payments).
   */
  async getSalesSummary(
    businessId: string,
    options: {from?: string; to?: string} = {},
  ) {
    // Heavy aggregation read by the dashboard — cached with a short TTL so the
    // DB isn't hit on every refresh. Kept fresh within TTL.ORDERS_SUMMARY; no
    // per-write invalidation (a new sale reflects once the TTL lapses).
    return this.cache.wrap(
      CacheKeys.ordersSummary(businessId, options),
      () => this.computeSalesSummary(businessId, options),
      TTL.ORDERS_SUMMARY,
    );
  }

  private async computeSalesSummary(
    businessId: string,
    options: {from?: string; to?: string} = {},
  ): Promise<{
    count: number;
    units: number;
    revenue: number;
    cash: number;
    card: number;
    debt: number;
  }> {
    const where = [
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
    ];
    if (options.from) {
      where.push(gte(orders.createdAt, businessDayStart(options.from)));
    }
    if (options.to) {
      where.push(lte(orders.createdAt, businessDayEnd(options.to)));
    }
    const whereSql = and(...where)!;

    const [totals] = await this.dbService.db
      .select({
        count: count(),
        units: sql<string>`COALESCE(SUM(${orders.itemCount}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(whereSql);

    // Money actually received, split by method (unnests the payments jsonb).
    const byMethod = await this.dbService.db.execute<{
      method: string;
      total: string;
    }>(sql`
      SELECT p.value->>'method' AS method,
             COALESCE(SUM((p.value->>'amount')::numeric), 0) AS total
      FROM ${orders}, jsonb_array_elements(${orders.payments}) AS p
      WHERE ${whereSql}
      GROUP BY 1
    `);
    const methodRows: {method: string; total: string}[] =
      (byMethod as unknown as {rows?: {method: string; total: string}[]})
        .rows ?? (byMethod as unknown as {method: string; total: string}[]);
    const methodTotal = (m: string) =>
      Number(methodRows.find((r) => r.method === m)?.total ?? 0);

    // Outstanding debt created in the range: debt orders' totals minus what
    // was paid down at the till.
    const [debtRow] = await this.dbService.db
      .select({
        total: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        paid: sql<string>`COALESCE(SUM((
          SELECT COALESCE(SUM((p.value->>'amount')::numeric), 0)
          FROM jsonb_array_elements(${orders.payments}) AS p
        )), 0)`,
      })
      .from(orders)
      .where(and(whereSql, eq(orders.paymentMethod, 'debt')));

    return {
      count: Number(totals.count),
      units: Number(totals.units),
      revenue: Number(totals.revenue),
      cash: methodTotal('cash'),
      card: methodTotal('card'),
      debt: Math.max(0, Number(debtRow.total) - Number(debtRow.paid)),
    };
  }

  async getCount(businessId: string): Promise<number> {
    const result = await this.dbService.db
      .select({count: count()})
      .from(orders)
      .where(eq(orders.businessId, businessId));
    return result[0].count;
  }

  /**
   * Per-product sales aggregation from completed orders. Units sold, revenue and
   * cost all come from the order_items snapshots (so deleted products still count
   * and COGS reflects the cost at sale time, not the current price). Pre-migration
   * rows have costTotal=0 and fall back to the product's current `priceIn`.
   * Optional inclusive date range filters on the order's creation date.
   */
  async getProductPerformance(
    businessId: string,
    options?: {from?: string; to?: string; branchId?: string},
  ) {
    return this.cache.wrap(
      CacheKeys.ordersPerformance(businessId, options),
      () => this.computeProductPerformance(businessId, options),
      TTL.ORDERS_PERFORMANCE,
    );
  }

  private async computeProductPerformance(
    businessId: string,
    options?: {from?: string; to?: string; branchId?: string},
  ): Promise<
    {
      productId: string | null;
      name: string;
      code: string | null;
      image: string | null;
      category: string | null;
      unitsSold: number;
      revenue: number;
      profit: number;
      profitMargin: number;
    }[]
  > {
    const where = [
      eq(orderItems.businessId, businessId),
      eq(orders.status, 'Completed'),
    ];
    if (options?.from) {
      where.push(gte(orders.createdAt, businessDayStart(options.from)));
    }
    if (options?.to) {
      // Include the whole "to" day (business-local).
      where.push(lte(orders.createdAt, businessDayEnd(options.to)));
    }
    if (options?.branchId) {
      where.push(eq(orders.branchId, options.branchId));
    }

    const rows = await this.dbService.db
      .select({
        productId: orderItems.productId,
        name: sql<string>`MAX(${orderItems.productName})`,
        code: sql<string | null>`MAX(${products.code})`,
        image: sql<string | null>`MAX(${products.image})`,
        category: sql<string | null>`MAX(${categories.name})`,
        unitsSold: sql<string>`COALESCE(SUM(${orderItems.quantity}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${orderItems.lineTotal}), 0)`,
        // COGS from the per-sale snapshot (accurate after price changes). Falls
        // back to current priceIn for pre-migration rows where costTotal is 0.
        cost: sql<string>`COALESCE(SUM(
          CASE WHEN ${orderItems.costTotal} > 0
            THEN ${orderItems.costTotal}
            ELSE ${orderItems.quantity} * COALESCE(${products.priceIn}, 0)
          END
        ), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .leftJoin(products, eq(orderItems.productId, products.id))
      .leftJoin(
        categories,
        and(
          eq(products.categoryId, categories.id),
          eq(categories.businessId, businessId),
        ),
      )
      .where(and(...where))
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`SUM(${orderItems.lineTotal})`));

    return rows.map((r) => {
      const revenue = Number(r.revenue);
      const profit = revenue - Number(r.cost);
      return {
        productId: r.productId,
        name: r.name,
        code: r.code,
        image: r.image,
        category: r.category,
        unitsSold: Number(r.unitsSold),
        revenue,
        profit,
        profitMargin: revenue > 0 ? (profit / revenue) * 100 : 0,
      };
    });
  }

  async getRevenue(businessId: string): Promise<number> {
    return this.cache.wrap(
      CacheKeys.ordersRevenue(businessId),
      () => this.computeRevenue(businessId),
      TTL.ORDERS_REVENUE,
    );
  }

  private async computeRevenue(businessId: string): Promise<number> {
    const [row] = await this.dbService.db
      .select({
        sum: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(eq(orders.businessId, businessId), eq(orders.status, 'Completed')),
      );
    return Number(row?.sum ?? 0);
  }

  /**
   * Completed-order revenue grouped by calendar month for a given year.
   * Returns exactly 12 numbers (Jan..Dec); months with no sales are 0.
   */
  async getMonthlySales(businessId: string, year: number): Promise<number[]> {
    return this.cache.wrap(
      CacheKeys.ordersMonthly(businessId, {year}),
      () => this.computeMonthlySales(businessId, year),
      TTL.ORDERS_MONTHLY,
    );
  }

  private async computeMonthlySales(
    businessId: string,
    year: number,
  ): Promise<number[]> {
    const rows = await this.dbService.db
      .select({
        month: sql<number>`EXTRACT(MONTH FROM ${orders.createdAt})`,
        sum: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          sql`EXTRACT(YEAR FROM ${orders.createdAt}) = ${year}`,
        ),
      )
      .groupBy(sql`EXTRACT(MONTH FROM ${orders.createdAt})`);

    const monthly = new Array<number>(12).fill(0);
    for (const r of rows) {
      const m = Number(r.month);
      if (m >= 1 && m <= 12) monthly[m - 1] = Number(r.sum);
    }
    return monthly;
  }

  /**
   * Completed-order sales grouped by the cashier (acting account) who rang them
   * up. `cashierId === null` covers storefront/guest and pre-migration orders.
   */
  async getSalesByEmployee(
    businessId: string,
    options: {from?: string; to?: string} = {},
  ) {
    return this.cache.wrap(
      CacheKeys.ordersByEmployee(businessId, options),
      () => this.computeSalesByEmployee(businessId, options),
      TTL.ORDERS_BY_EMPLOYEE,
    );
  }

  private async computeSalesByEmployee(
    businessId: string,
    options: {from?: string; to?: string} = {},
  ): Promise<
    Array<{
      cashierId: string | null;
      cashierName: string | null;
      orderCount: number;
      revenue: number;
    }>
  > {
    const where = [
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
    ];
    if (options.from) {
      where.push(gte(orders.createdAt, businessDayStart(options.from)));
    }
    if (options.to) {
      where.push(lte(orders.createdAt, businessDayEnd(options.to)));
    }

    const rows = await this.dbService.db
      .select({
        cashierId: orders.cashierId,
        cashierName: sql<string | null>`MAX(${orders.cashierName})`,
        orderCount: count(),
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(and(...where))
      .groupBy(orders.cashierId)
      .orderBy(desc(sql`COALESCE(SUM(${orders.totalAmount}), 0)`));

    return rows.map((r) => ({
      cashierId: r.cashierId,
      cashierName: r.cashierName ?? null,
      orderCount: Number(r.orderCount),
      revenue: Number(r.revenue),
    }));
  }
}
