import {Injectable} from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  debtPayments,
  inventoryBatches,
  loyaltySettings,
  loyaltyTransactions,
  orderItems,
  orders,
  products,
  saleReturnItems,
  saleReturns,
  userDebts,
  users,
  type Order,
  type OrderItem,
  type SaleReturn,
  type SaleReturnItem,
} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {applyBranchStockDelta} from '../common/branch-stock';
import {businessDayEnd, businessDayStart} from '../common/business-time';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {OrderService} from './order.service';
import {computeReturn, ReturnResult} from './return-math';
import {CreateSaleReturnDto, PreviewSaleReturnDto} from './dto/sale-return.dto';

type DbTx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];
type Db = DatabaseService['db'] | DbTx;

const money = (n: number) => n.toFixed(2);
const EPS = 1e-6;

export type SaleReturnWithItems = SaleReturn & {items: SaleReturnItem[]};

export interface ReturnableLine extends OrderItem {
  /** quantity − returnedQuantity, never negative. */
  returnableQuantity: number;
  /** Weighed goods (fractional kg) — piece goods must come back whole. */
  isKg: boolean;
}

export interface ReceiptLookup {
  order: Order & {items: ReturnableLine[]};
  returns: SaleReturnWithItems[];
  /** Unpaid remainder of the sale's debt now (0 for a paid sale). */
  debtRemaining: number;
  /** Completed and something is still returnable. */
  returnable: boolean;
}

export interface ReturnPreview extends Omit<ReturnResult, 'lines'> {
  lines: (ReturnResult['lines'][number] & {productName: string})[];
  /** Default refund split: everything via the sale's main payment method. */
  suggestedRefunds: {method: string; amount: number}[];
}

/** Everything about an order's return state that the math needs. */
interface OrderReturnState {
  order: Order;
  items: OrderItem[];
  prior: Map<string, {gross: number; cost: number}>;
  pointsRestoredSoFar: number;
  pointsReversedSoFar: number;
  pointsEarned: number;
  debt: {id: string; amount: number; paid: number; status: string} | null;
  kinds: Map<string, {exists: boolean; isKg: boolean}>;
}

/**
 * Customer returns ("qaytarish"): find a sale by its receipt number, bring
 * some of its lines back, and settle the value — debt first, then spent
 * loyalty points, then money out of the current shift. The sale itself stays
 * as sold; the return document is the history and what reports net against.
 */
@Injectable()
export class SaleReturnService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly orderService: OrderService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ─── Lookup ───────────────────────────────────────────────────────────────

  /**
   * Resolve what a cashier typed or scanned: a receipt number ("1245",
   * "#1245", "R1245") or, for receipts printed before numbering, the 8-char
   * id prefix that used to be printed.
   */
  async lookup(businessId: string, ref: string): Promise<ReceiptLookup> {
    const raw = (ref ?? '').trim().replace(/^[#№Rr]\s*/, '');
    let order: Order | undefined;
    if (/^\d{1,9}$/.test(raw)) {
      [order] = await this.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.businessId, businessId),
            eq(orders.receiptNo, Number(raw)),
          ),
        )
        .limit(1);
    } else if (/^[0-9a-f-]{6,36}$/i.test(raw)) {
      [order] = await this.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.businessId, businessId),
            ilike(orders.id, `${raw.toLowerCase()}%`),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(1);
    }
    if (!order || order.status === 'Held') {
      throw new AppException(ErrorCode.SALE_RECEIPT_NOT_FOUND, {ref: raw});
    }

    const state = await this.loadState(this.db, businessId, order);
    const items: ReturnableLine[] = state.items.map((it) => ({
      ...it,
      returnableQuantity: Math.max(
        0,
        Math.round((it.quantity - it.returnedQuantity) * 1000) / 1000,
      ),
      isKg: this.isKg(it, state),
    }));
    const returns = await this.findAll(businessId, {orderId: order.id, limit: 100});
    return {
      order: {...order, items},
      returns: returns.returns,
      debtRemaining: state.debt
        ? Math.max(0, state.debt.amount - state.debt.paid)
        : 0,
      returnable:
        order.status === 'Completed' &&
        items.some((i) => i.returnableQuantity > EPS),
    };
  }

  // ─── Preview / create ─────────────────────────────────────────────────────

  async preview(
    businessId: string,
    dto: PreviewSaleReturnDto,
  ): Promise<ReturnPreview> {
    const order = await this.loadOrder(this.db, businessId, dto.orderId);
    const state = await this.loadState(this.db, businessId, order);
    const result = this.compute(state, dto);
    return {
      ...result,
      lines: this.withNames(result, state),
      suggestedRefunds:
        result.refundAmount > 0
          ? [{method: this.mainMethod(order), amount: result.refundAmount}]
          : [],
    };
  }

  async create(
    businessId: string,
    dto: CreateSaleReturnDto,
    account?: IAccount,
  ): Promise<SaleReturnWithItems> {
    // Same freeze as sales: a count in progress relies on stable stock.
    await this.orderService.assertNoStockTakeInProgress(businessId);
    const cashier = await this.orderService.resolveCashier(account);
    // Money leaves the till, so — like a sale — an open shift is required, and
    // the goods come back to the store that shift's register belongs to.
    const shiftId = await this.orderService.resolveShiftForSale(businessId, dto);
    const branchId = await this.orderService.resolveSaleBranch(
      businessId,
      undefined,
      shiftId,
    );

    const returnId = generateId();
    await this.db.transaction(async (tx) => {
      // Lock the sale so two tills can't return the same units at once.
      const order = await this.loadOrder(tx, businessId, dto.orderId, true);
      const state = await this.loadState(tx, businessId, order);
      const result = this.compute(state, dto);
      const refunds = this.resolveRefunds(order, result.refundAmount, dto);
      const byId = new Map(state.items.map((i) => [i.id, i]));

      await tx.insert(saleReturns).values({
        id: returnId,
        businessId,
        orderId: order.id,
        orderReceiptNo: order.receiptNo,
        branchId,
        shiftId,
        cashierId: cashier.id,
        cashierName: cashier.name,
        creditedStaffId: order.sellerId ?? order.cashierId,
        creditedStaffName: order.sellerId ? order.sellerName : order.cashierName,
        userId: order.userId,
        customerName: order.customerName,
        reason: dto.reason?.trim() || null,
        itemCount: result.itemCount,
        grossAmount: money(result.grossAmount),
        discountAmount: money(result.discountAmount),
        totalAmount: money(result.totalAmount),
        debtReduced: money(result.debtReduced),
        pointsRestored: money(result.pointsRestored),
        pointsReversed: money(result.pointsReversed),
        refundAmount: money(result.refundAmount),
        refunds,
        costTotal: money(result.costTotal),
        restockedCost: money(result.restockedCost),
      });

      for (const line of result.lines) {
        const item = byId.get(line.orderItemId)!;
        const unitCost = item.quantity > 0 ? Number(item.costTotal) / item.quantity : 0;
        await tx.insert(saleReturnItems).values({
          id: generateId(),
          returnId,
          businessId,
          orderItemId: item.id,
          productId: item.productId,
          productName: item.productName,
          quantity: line.quantity,
          priceOut: item.priceOut,
          lineTotal: money(line.lineTotal),
          netAmount: money(line.netAmount),
          costIn: money(unitCost),
          costTotal: money(line.costTotal),
          restock: line.restock,
        });
        await tx
          .update(orderItems)
          .set({
            returnedQuantity: sql`ROUND((${orderItems.returnedQuantity} + ${line.quantity})::numeric, 3)`,
          })
          .where(eq(orderItems.id, item.id));

        // Back on the shelf: a fresh lot at the line's own cost/price snapshot
        // (FIFO can't hand back the exact lot it drew from), in this store.
        const kind = item.productId ? state.kinds.get(item.productId) : undefined;
        if (line.restock && item.productId && kind?.exists) {
          await tx.insert(inventoryBatches).values({
            id: generateId(),
            businessId,
            productId: item.productId,
            receiptItemId: null,
            branchId,
            priceIn: money(unitCost),
            priceOut: item.priceOut,
            qtyReceived: line.quantity,
            qtyRemaining: line.quantity,
          });
          await applyBranchStockDelta(
            tx,
            businessId,
            item.productId,
            branchId,
            line.quantity,
          );
        }
      }

      await tx
        .update(orders)
        .set({
          returnedAmount: sql`${orders.returnedAmount} + ${money(result.totalAmount)}`,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));

      // Credit sale: write the unpaid remainder down (a credit note, not a
      // payment — no money moved), then re-derive its status.
      if (state.debt && result.debtReduced > 0) {
        const newAmount = Math.max(0, state.debt.amount - result.debtReduced);
        const paid = state.debt.paid;
        const status =
          paid >= newAmount - 0.005
            ? 'Paid'
            : paid > 0
              ? 'Partial'
              : state.debt.status === 'Overdue'
                ? 'Overdue'
                : 'Pending';
        await tx
          .update(userDebts)
          .set({amount: money(newAmount), status, updatedAt: new Date()})
          .where(eq(userDebts.id, state.debt.id));
      }

      await this.applyLoyalty(tx, businessId, order, result);
    });

    return this.findOne(businessId, returnId);
  }

  // ─── History ──────────────────────────────────────────────────────────────

  async findAll(
    businessId: string,
    options: {
      page?: number;
      limit?: number;
      from?: string;
      to?: string;
      orderId?: string;
      search?: string;
    } = {},
  ): Promise<{
    returns: SaleReturnWithItems[];
    total: number;
    page: number;
    limit: number;
    /** Sums over every return matching the filters, not just this page. */
    totals: {
      totalAmount: number;
      refundAmount: number;
      debtReduced: number;
      pointsRestored: number;
    };
  }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);
    const where = [eq(saleReturns.businessId, businessId)];
    if (options.orderId) where.push(eq(saleReturns.orderId, options.orderId));
    if (options.from) {
      where.push(gte(saleReturns.createdAt, businessDayStart(options.from)));
    }
    if (options.to) {
      where.push(lte(saleReturns.createdAt, businessDayEnd(options.to)));
    }
    const term = options.search?.trim().replace(/^[#№Rr]\s*/, '');
    if (term) {
      const conds = [
        ilike(saleReturns.customerName, `%${term}%`),
        ilike(saleReturns.cashierName, `%${term}%`),
        ilike(saleReturns.reason, `%${term}%`),
      ];
      if (/^\d{1,9}$/.test(term)) {
        conds.push(eq(saleReturns.orderReceiptNo, Number(term)));
      }
      where.push(or(...conds)!);
    }

    const [agg] = await this.db
      .select({
        value: count(),
        totalAmount: sql<string>`COALESCE(SUM(${saleReturns.totalAmount}), 0)`,
        refundAmount: sql<string>`COALESCE(SUM(${saleReturns.refundAmount}), 0)`,
        debtReduced: sql<string>`COALESCE(SUM(${saleReturns.debtReduced}), 0)`,
        pointsRestored: sql<string>`COALESCE(SUM(${saleReturns.pointsRestored}), 0)`,
      })
      .from(saleReturns)
      .where(and(...where));
    const total = agg?.value ?? 0;
    const rows = await this.db
      .select()
      .from(saleReturns)
      .where(and(...where))
      .orderBy(desc(saleReturns.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    const items = rows.length
      ? await this.db
          .select()
          .from(saleReturnItems)
          .where(
            inArray(
              saleReturnItems.returnId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    const byReturn = new Map<string, SaleReturnItem[]>();
    for (const it of items) {
      const list = byReturn.get(it.returnId) ?? [];
      list.push(it);
      byReturn.set(it.returnId, list);
    }
    return {
      returns: rows.map((r) => ({...r, items: byReturn.get(r.id) ?? []})),
      total: Number(total),
      page,
      limit,
      totals: {
        totalAmount: Number(agg?.totalAmount ?? 0),
        refundAmount: Number(agg?.refundAmount ?? 0),
        debtReduced: Number(agg?.debtReduced ?? 0),
        pointsRestored: Number(agg?.pointsRestored ?? 0),
      },
    };
  }

  async findOne(businessId: string, id: string): Promise<SaleReturnWithItems> {
    const [row] = await this.db
      .select()
      .from(saleReturns)
      .where(and(eq(saleReturns.businessId, businessId), eq(saleReturns.id, id)))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.RETURN_NOT_FOUND);
    const items = await this.db
      .select()
      .from(saleReturnItems)
      .where(eq(saleReturnItems.returnId, id));
    return {...row, items};
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async loadOrder(
    db: Db,
    businessId: string,
    orderId: string,
    lock = false,
  ): Promise<Order> {
    const q = db
      .select()
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.id, orderId)))
      .limit(1);
    const [order] = lock ? await q.for('update') : await q;
    if (!order) throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    if (order.status !== 'Completed') {
      throw new AppException(ErrorCode.RETURN_ORDER_NOT_RETURNABLE);
    }
    return order;
  }

  private async loadState(
    db: Db,
    businessId: string,
    order: Order,
  ): Promise<OrderReturnState> {
    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    const priorRows = await db
      .select({
        orderItemId: saleReturnItems.orderItemId,
        gross: sql<string>`COALESCE(SUM(${saleReturnItems.lineTotal}), 0)`,
        cost: sql<string>`COALESCE(SUM(${saleReturnItems.costTotal}), 0)`,
      })
      .from(saleReturnItems)
      .innerJoin(saleReturns, eq(saleReturnItems.returnId, saleReturns.id))
      .where(eq(saleReturns.orderId, order.id))
      .groupBy(saleReturnItems.orderItemId);
    const prior = new Map(
      priorRows.map((r) => [
        r.orderItemId,
        {gross: Number(r.gross), cost: Number(r.cost)},
      ]),
    );

    const [points] = await db
      .select({
        restored: sql<string>`COALESCE(SUM(${saleReturns.pointsRestored}), 0)`,
        reversed: sql<string>`COALESCE(SUM(${saleReturns.pointsReversed}), 0)`,
      })
      .from(saleReturns)
      .where(eq(saleReturns.orderId, order.id));

    const [earned] = await db
      .select({
        value: sql<string>`COALESCE(SUM(${loyaltyTransactions.amount}), 0)`,
      })
      .from(loyaltyTransactions)
      .where(
        and(
          eq(loyaltyTransactions.orderId, order.id),
          eq(loyaltyTransactions.type, 'earn'),
        ),
      );

    let debt: OrderReturnState['debt'] = null;
    const [d] = await db
      .select()
      .from(userDebts)
      .where(
        and(eq(userDebts.businessId, businessId), eq(userDebts.orderId, order.id)),
      )
      .limit(1);
    if (d) {
      const [paid] = await db
        .select({value: sql<string>`COALESCE(SUM(${debtPayments.amount}), 0)`})
        .from(debtPayments)
        .where(eq(debtPayments.debtId, d.id));
      debt = {
        id: d.id,
        amount: Number(d.amount),
        paid: Number(paid?.value ?? 0),
        status: d.status,
      };
    }

    const productIds = items
      .map((i) => i.productId)
      .filter((id): id is string => !!id);
    const kinds = new Map<string, {exists: boolean; isKg: boolean}>();
    if (productIds.length) {
      const rows = await db
        .select({id: products.id, quantityType: products.quantityType})
        .from(products)
        .where(inArray(products.id, productIds));
      for (const r of rows) {
        kinds.set(r.id, {exists: true, isKg: r.quantityType === 'kg'});
      }
    }

    return {
      order,
      items,
      prior,
      pointsRestoredSoFar: Number(points?.restored ?? 0),
      pointsReversedSoFar: Number(points?.reversed ?? 0),
      pointsEarned: Number(earned?.value ?? 0),
      debt,
      kinds,
    };
  }

  private isKg(item: OrderItem, state: OrderReturnState): boolean {
    const kind = item.productId ? state.kinds.get(item.productId) : undefined;
    // A deleted product: infer from the sold quantity.
    return kind ? kind.isKg : !Number.isInteger(item.quantity);
  }

  /** Validate the requested lines against the receipt and run the math. */
  private compute(
    state: OrderReturnState,
    dto: PreviewSaleReturnDto & {items: {restock?: boolean}[]},
  ): ReturnResult {
    const byId = new Map(state.items.map((i) => [i.id, i]));
    const requested = new Map<string, {qty: number; restock: boolean}>();
    for (const it of dto.items) {
      const item = byId.get(it.orderItemId);
      if (!item) throw new AppException(ErrorCode.RETURN_ITEM_NOT_IN_ORDER);
      const prev = requested.get(it.orderItemId);
      requested.set(it.orderItemId, {
        qty: (prev?.qty ?? 0) + it.quantity,
        restock: it.restock ?? prev?.restock ?? true,
      });
    }
    if (requested.size === 0) throw new AppException(ErrorCode.RETURN_EMPTY);

    for (const [id, req] of requested) {
      const item = byId.get(id)!;
      const max = Math.max(0, item.quantity - item.returnedQuantity);
      if (req.qty > max + EPS) {
        throw new AppException(ErrorCode.RETURN_QTY_EXCEEDS, {
          productName: item.productName,
          max: Math.round(max * 1000) / 1000,
        });
      }
      if (!this.isKg(item, state) && !Number.isInteger(req.qty)) {
        throw new AppException(ErrorCode.RETURN_QTY_NOT_WHOLE, {
          productName: item.productName,
        });
      }
    }

    return computeReturn({
      orderSubtotal: Number(state.order.subtotalAmount),
      orderTotal: Number(state.order.totalAmount),
      orderReturnedAmount: Number(state.order.returnedAmount),
      lines: state.items.map((item) => {
        const req = requested.get(item.id);
        const prior = state.prior.get(item.id);
        return {
          orderItemId: item.id,
          soldQty: item.quantity,
          lineTotal: Number(item.lineTotal),
          costTotal: Number(item.costTotal),
          returnedQty: item.returnedQuantity,
          returnedGross: prior?.gross ?? 0,
          returnedCost: prior?.cost ?? 0,
          isKg: this.isKg(item, state),
          requestQty: req?.qty ?? 0,
          restock: req?.restock ?? true,
        };
      }),
      debtRemaining: state.debt
        ? Math.max(0, state.debt.amount - state.debt.paid)
        : 0,
      pointsRedeemed: Number(state.order.loyaltyRedeemed),
      pointsRestoredSoFar: state.pointsRestoredSoFar,
      pointsEarned: state.pointsEarned,
      pointsReversedSoFar: state.pointsReversedSoFar,
    });
  }

  private withNames(result: ReturnResult, state: OrderReturnState) {
    const names = new Map(state.items.map((i) => [i.id, i.productName]));
    return result.lines.map((l) => ({
      ...l,
      productName: names.get(l.orderItemId) ?? '',
    }));
  }

  /** The tender that carried most of the sale — the default refund route. */
  private mainMethod(order: Order): string {
    const pays = (order.payments as {method: string; amount: number}[] | null) ?? [];
    const top = [...pays].sort((a, b) => b.amount - a.amount)[0];
    return top?.method && top.method !== 'debt' ? top.method : 'cash';
  }

  private resolveRefunds(
    order: Order,
    refundAmount: number,
    dto: CreateSaleReturnDto,
  ): {method: string; amount: number}[] {
    if (refundAmount <= 0) return [];
    const given = (dto.refunds ?? []).filter((r) => r.amount > 0);
    if (given.length === 0) {
      return [{method: this.mainMethod(order), amount: refundAmount}];
    }
    const sum = given.reduce((s, r) => s + r.amount, 0);
    if (Math.abs(sum - refundAmount) > 0.01) {
      throw new AppException(ErrorCode.RETURN_REFUND_MISMATCH, {
        expected: refundAmount,
      });
    }
    return given.map((r) => ({method: r.method, amount: r.amount}));
  }

  /**
   * Hand spent points back and take earned cashback back, as ledger rows on
   * the customer's locked balance. Lifetime spend drops by the returned value
   * so tiers track net purchases.
   */
  private async applyLoyalty(
    tx: DbTx,
    businessId: string,
    order: Order,
    result: ReturnResult,
  ): Promise<void> {
    if (!order.userId) return;
    const [settings] = await tx
      .select({enabled: loyaltySettings.enabled})
      .from(loyaltySettings)
      .where(eq(loyaltySettings.businessId, businessId))
      .limit(1);
    const touchesPoints = result.pointsRestored > 0 || result.pointsReversed > 0;
    if (!touchesPoints && !settings?.enabled) return;

    const [cust] = await tx
      .select({bonusBalance: users.bonusBalance, totalSpent: users.totalSpent})
      .from(users)
      .where(eq(users.id, order.userId))
      .for('update');
    if (!cust) return;

    let balance = Number(cust.bonusBalance);
    const note = order.receiptNo ? `#${order.receiptNo}` : null;
    if (result.pointsRestored > 0) {
      balance += result.pointsRestored;
      await tx.insert(loyaltyTransactions).values({
        id: generateId(),
        businessId,
        userId: order.userId,
        orderId: order.id,
        type: 'return',
        amount: money(result.pointsRestored),
        balanceAfter: money(balance),
        note,
      });
    }
    if (result.pointsReversed > 0) {
      // The customer may already have spent the cashback; never go negative.
      const taken = Math.min(result.pointsReversed, balance);
      if (taken > 0) {
        balance -= taken;
        await tx.insert(loyaltyTransactions).values({
          id: generateId(),
          businessId,
          userId: order.userId,
          orderId: order.id,
          type: 'return',
          amount: money(-taken),
          balanceAfter: money(balance),
          note,
        });
      }
    }
    await tx
      .update(users)
      .set({
        bonusBalance: money(balance),
        totalSpent: money(
          Math.max(0, Number(cust.totalSpent) - result.totalAmount),
        ),
        updatedAt: new Date(),
      })
      .where(eq(users.id, order.userId));
  }
}
