import {Injectable} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  branchStock,
  branches,
  cashShifts,
  orderItems,
  orderPayments,
  orderStatusEvents,
  orders,
  products,
  staff,
  type Order,
  type OrderItem,
} from '../database/schema';
import {FinanceService} from '../finance/finance.service';
import {ReceiptService} from '../receipt/receipt.service';
import {StoreSettingsService} from './store-settings.service';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {itemCountOf} from '../common/item-count';
import {IAccount} from '../business/types';
import {TelegramNotifyService} from '../telegram/telegram-notify.service';
import type {StoreOrderMessageKind} from '../telegram/store-order-messages';
import {generateId} from '../utils/uuid';
import {OrderService, OrderWithItems} from './order.service';
import {
  CUSTOMER_CANCEL_REASON,
  IN_PROGRESS_STATUSES,
  ONLINE_GROUPS,
  STAFF_CANCEL_REASONS,
  canTransition,
  deliveryTypeOf,
  legacyTarget,
  needsStock,
  type OnlineGroup,
  type OnlineStatus,
  type OrderChannel,
  type StaffCancelReason,
} from './online-order.rules';

type DbTx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

interface Actor {
  type: 'owner' | 'staff' | 'customer';
  id: string | null;
  name: string | null;
}

/** One row of the admin online-orders list (YETKAZISH.md §4.1). */
export interface OnlineOrderView {
  id: string;
  receiptNo: number | null;
  status: string;
  deliveryType: 'pickup' | 'delivery';
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  deliveryLat: number | null;
  deliveryLng: number | null;
  note: string | null;
  totalAmount: string;
  deliveryFee: string;
  payable: string;
  itemCount: number;
  courierId: string | null;
  courierName: string | null;
  courierPhone: string | null;
  cancelReason: string | null;
  cancelNote: string | null;
  placedAt: Date;
  statusChangedAt: Date;
  createdAt: Date;
  // ── Online seller (ONLAYN-SOTUVCHI.md §9.1) ──
  prepaidAmount: string;
  balanceDue: string;
  channel: string | null;
  pendingLines: number;
  stockReady: boolean;
}

export interface OrderPaymentView {
  id: string;
  kind: string;
  amount: string;
  method: string;
  accountId: string | null;
  accountName: string | null;
  actorName: string | null;
  note: string | null;
  createdAt: Date;
}

export interface OnlineOrderDetail extends OnlineOrderView {
  items: {
    id: string;
    productId: string | null;
    productName: string;
    quantity: number;
    priceOut: string;
    lineTotal: string;
    quantityType: string | null;
    stockTaken: boolean;
    options: {name: string; value: string}[] | null;
    available: number | null;
  }[];
  orderPayments: OrderPaymentView[];
  depositOutcome: 'refunded' | 'kept' | null;
  events: {
    id: string;
    fromStatus: string | null;
    toStatus: string;
    actorType: string;
    actorName: string | null;
    courierName: string | null;
    reason: string | null;
    note: string | null;
    createdAt: Date;
  }[];
  payments: {method: string; amount: number}[] | null;
  paymentMethod: string | null;
  shiftId: string | null;
  branchName: string | null;
}

/** What the storefront customer sees of their order (§4.3). */
export interface StorefrontOrderView {
  id: string;
  status: string;
  deliveryType: 'pickup' | 'delivery';
  totalAmount: string;
  deliveryFee: string;
  payable: string;
  itemCount: number;
  createdAt: Date;
  deliveryAddress: string | null;
  courier: {name: string; phone: string | null} | null;
  pickup: {branchName: string; address: string | null} | null;
  cancelReason: string | null;
  // Only the staff's own words for an 'other' cancel; never internal notes.
  cancelNote: string | null;
  canCancel: boolean;
  timeline: {status: string; at: Date}[];
  items: {
    productName: string;
    quantity: number;
    lineTotal: string;
    // The buyer's choices (ONLAYN-SOTUVCHI.md Q8), null when none.
    options: {name: string; value: string}[] | null;
  }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Only well-formed {name, value} pairs, trimmed; none → null. */
function cleanOptions(
  raw: {name: string; value: string}[] | null | undefined,
): {name: string; value: string}[] | null {
  const out = (raw ?? [])
    .map((o) => ({
      name: String(o?.name ?? '').trim().slice(0, 40),
      value: String(o?.value ?? '').trim().slice(0, 40),
    }))
    .filter((o) => o.name && o.value)
    .slice(0, 3);
  return out.length ? out : null;
}
const money = (n: number) => round2(n).toFixed(2);
// Money is stored to 2dp; anything below this is rounding, not a mismatch.
const EPSILON = 0.5;

const payableOf = (o: Pick<Order, 'totalAmount' | 'deliveryFee'>) =>
  round2(Number(o.totalAmount) + Number(o.deliveryFee));

// What is still to be taken at hand-over: goods + delivery − deposits.
const dueOf = (
  o: Pick<Order, 'totalAmount' | 'deliveryFee' | 'prepaidAmount'>,
) => Math.max(0, round2(payableOf(o) - Number(o.prepaidAmount)));

type Tender = {method: string; amount: number; accountId?: string | null};

// One figure per method, so a shift or receipt reads one line each.
function mergeTender(
  lines: {method: string; amount: number}[],
): {method: string; amount: number}[] {
  const merged = new Map<string, number>();
  for (const t of lines)
    merged.set(t.method, round2((merged.get(t.method) ?? 0) + t.amount));
  return Array.from(merged, ([method, amount]) => ({method, amount}));
}

// Lines of the order still waiting for their goods.
// Written with the table name spelled out: in a select with no join Drizzle
// renders `${orders.id}` as a bare "id", which inside these subqueries binds
// to order_items.id instead and silently reads every order as having none.
const pendingLinesSql = sql<number>`(SELECT count(*)::int FROM order_items i WHERE i.order_id = "orders"."id" AND i.stock_pending)`;
// Every waiting line fits in the order branch's stock right now ("Tovar bor").
// Per order: two orders may both read ready for the same last units — the
// seller decides who gets them (Q6, no auto-allocation).
const stockReadySql = sql<boolean>`(EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = "orders"."id" AND i.stock_pending) AND NOT EXISTS (SELECT 1 FROM (SELECT i.product_id, sum(i.quantity) AS q FROM order_items i WHERE i.order_id = "orders"."id" AND i.stock_pending AND i.product_id IS NOT NULL GROUP BY i.product_id) x LEFT JOIN branch_stock b ON b.product_id = x.product_id AND b.branch_id = "orders"."branch_id" WHERE coalesce(b.quantity, 0) + 0.000001 < x.q))`;

// Latest status move of an order — the "waiting since" of the list.
// "orders"."id" spelled out — see pendingLinesSql below.
const lastMoveAt = sql<Date | null>`(SELECT max(e.created_at) FROM order_status_events e WHERE e.order_id = "orders"."id") AT TIME ZONE 'UTC'`;

/**
 * Storefront orders after checkout (YETKAZISH.md): the state machine, the
 * staff actions on it, and the customer's own cancel. Till sales never pass
 * through here.
 */
@Injectable()
export class OnlineOrderService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly orderService: OrderService,
    private readonly telegramNotify: TelegramNotifyService,
    private readonly finance: FinanceService,
    private readonly storeSettings: StoreSettingsService,
    private readonly receipts: ReceiptService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────

  async list(
    businessId: string,
    options: {
      group?: OnlineGroup;
      search?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{
    orders: OnlineOrderView[];
    total: number;
    page: number;
    limit: number;
  }> {
    const group = options.group ?? 'all';
    const page = Math.max(options.page ?? 1, 1);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

    const where: SQL[] = [
      eq(orders.businessId, businessId),
      eq(orders.source, 'store'),
    ];
    if (group !== 'all') {
      where.push(inArray(orders.status, [...ONLINE_GROUPS[group]]));
    }
    const q = options.search?.trim();
    if (q) {
      const like = `%${q}%`;
      const terms: SQL[] = [
        ilike(orders.customerName, like),
        ilike(orders.customerPhone, like),
        ilike(orders.id, `${q}%`),
      ];
      if (/^\d{1,9}$/.test(q)) terms.push(eq(orders.receiptNo, Number(q)));
      where.push(or(...terms)!);
    }

    const [{total}] = await this.dbService.db
      .select({total: count()})
      .from(orders)
      .where(and(...where));

    // Work queues read oldest-first (who has waited longest); history newest.
    const waiting = group === 'new' || group === 'active';
    const rows = await this.dbService.db
      .select({
        order: orders,
        movedAt: lastMoveAt,
        pendingLines: pendingLinesSql,
        stockReady: stockReadySql,
      })
      .from(orders)
      .where(and(...where))
      .orderBy(
        ...(waiting
          ? [
              asc(sql`coalesce(${orders.placedAt}, ${orders.createdAt})`),
              asc(orders.id),
            ]
          : [desc(orders.updatedAt), desc(orders.id)]),
      )
      .limit(limit)
      .offset((page - 1) * limit);

    return {
      orders: rows.map((r) =>
        this.view(r.order, r.movedAt, {
          pendingLines: Number(r.pendingLines) || 0,
          stockReady: !!r.stockReady,
        }),
      ),
      total,
      page,
      limit,
    };
  }

  async counts(businessId: string): Promise<{
    new: number;
    active: number;
    awaiting: number;
    inwork: number;
    stockReady: number;
  }> {
    const rows = await this.dbService.db
      .select({status: orders.status, n: count()})
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.source, 'store'),
          inArray(orders.status, [...IN_PROGRESS_STATUSES]),
        ),
      )
      .groupBy(orders.status);
    const by = new Map(rows.map((r) => [r.status, r.n]));
    const sum = (statuses: readonly string[]) =>
      statuses.reduce((n, s) => n + (by.get(s) ?? 0), 0);
    const [{ready}] = await this.dbService.db
      .select({ready: count()})
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.source, 'store'),
          inArray(orders.status, ['Pending', 'Awaiting']),
          stockReadySql,
        ),
      );
    return {
      new: by.get('Pending') ?? 0,
      active: sum(ONLINE_GROUPS.active),
      awaiting: sum(ONLINE_GROUPS.awaiting),
      inwork: sum(ONLINE_GROUPS.inwork),
      stockReady: ready,
    };
  }

  async detail(businessId: string, id: string): Promise<OnlineOrderDetail> {
    const order = await this.load(businessId, id);
    const [lines, events, branch, money_] = await Promise.all([
      this.dbService.db
        .select({
          id: orderItems.id,
          productId: orderItems.productId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          priceOut: orderItems.priceOut,
          lineTotal: orderItems.lineTotal,
          quantityType: products.quantityType,
          stockPending: orderItems.stockPending,
          options: orderItems.options,
        })
        .from(orderItems)
        .leftJoin(products, eq(products.id, orderItems.productId))
        .where(eq(orderItems.orderId, id))
        .orderBy(asc(orderItems.createdAt), asc(orderItems.id)),
      this.events(id),
      order.branchId
        ? this.dbService.db
            .select({name: branches.name})
            .from(branches)
            .where(eq(branches.id, order.branchId))
            .limit(1)
        : Promise.resolve([]),
      this.paymentsOf(id),
    ]);

    // Stock on hand for the lines still waiting, at the order's branch.
    const waitingIds = [
      ...new Set(
        lines
          .filter((l) => l.stockPending && l.productId)
          .map((l) => l.productId!),
      ),
    ];
    const onHand = new Map<string, number>();
    if (waitingIds.length && order.branchId) {
      const rows = await this.dbService.db
        .select({productId: branchStock.productId, quantity: branchStock.quantity})
        .from(branchStock)
        .where(
          and(
            eq(branchStock.branchId, order.branchId),
            inArray(branchStock.productId, waitingIds),
          ),
        );
      for (const r of rows) onHand.set(r.productId, r.quantity);
    }
    const needed = new Map<string, number>();
    for (const l of lines) {
      if (l.stockPending && l.productId)
        needed.set(l.productId, (needed.get(l.productId) ?? 0) + l.quantity);
    }
    const pendingLines = lines.filter((l) => l.stockPending).length;
    const stockReady =
      pendingLines > 0 &&
      [...needed].every(([pid, q]) => (onHand.get(pid) ?? 0) + 1e-9 >= q);

    const movedAt = events.length ? events[events.length - 1].createdAt : null;
    const refunded = money_.some((p) => p.kind === 'refund');
    return {
      ...this.view(order, movedAt, {pendingLines, stockReady}),
      items: lines.map(({stockPending, ...l}) => ({
        ...l,
        stockTaken: !stockPending,
        available:
          stockPending && l.productId ? (onHand.get(l.productId) ?? 0) : null,
      })),
      orderPayments: money_,
      depositOutcome:
        order.status !== 'Cancelled'
          ? null
          : Number(order.prepaidAmount) > EPSILON
            ? 'kept'
            : refunded
              ? 'refunded'
              : null,
      events,
      payments:
        (order.payments as {method: string; amount: number}[] | null) ?? null,
      paymentMethod: order.paymentMethod,
      shiftId: order.shiftId,
      branchName: branch[0]?.name ?? null,
    };
  }

  // ── Staff actions ──────────────────────────────────────────────────────

  /**
   * Take the order (Pending) or continue it once the goods are in (Awaiting).
   * A new order whose waiting lines the branch still cannot cover goes to
   * Awaiting; anything else goes to Assembling, drawing those lines.
   */
  async accept(businessId: string, id: string, account: IAccount) {
    const actor = await this.actorOf(account);
    const [row] = await this.dbService.db
      .select({
        status: orders.status,
        pendingLines: pendingLinesSql,
        stockReady: stockReadySql,
      })
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    if (
      row.status === 'Pending' &&
      Number(row.pendingLines) > 0 &&
      !row.stockReady
    ) {
      return this.move(businessId, id, 'Awaiting', actor);
    }
    return this.move(businessId, id, 'Assembling', actor);
  }

  async dispatch(
    businessId: string,
    id: string,
    account: IAccount,
    courierId?: string | null,
  ) {
    let courier: {id: string; name: string; phone: string | null} | null = null;
    if (courierId) {
      const [row] = await this.dbService.db
        .select({id: staff.id, name: staff.name, phone: staff.phone})
        .from(staff)
        .where(and(eq(staff.businessId, businessId), eq(staff.id, courierId)))
        .limit(1);
      if (!row) throw new AppException(ErrorCode.COURIER_NOT_FOUND);
      courier = row;
    }
    return this.move(
      businessId,
      id,
      'Delivering',
      await this.actorOf(account),
      {
        courierName: courier?.name ?? null,
        set: {
          courierId: courier?.id ?? null,
          courierName: courier?.name ?? null,
          courierPhone: courier?.phone ?? null,
        },
      },
    );
  }

  async ready(businessId: string, id: string, account: IAccount) {
    return this.move(
      businessId,
      id,
      'ReadyForPickup',
      await this.actorOf(account),
    );
  }

  /**
   * Hand-over: what is still due is taken now (Q11) and the order becomes a
   * sale dated today (Q13). The money goes into the completing account's open
   * shift as before (Q12) — unless the order carries a deposit, a tender names
   * an account, or nobody's shift is open: then every tender is booked
   * straight into a Moliya account (ONLAYN-SOTUVCHI.md Q5), the deposits are
   * already there, and the order is tied to no shift so the shift report
   * never counts the deposit twice. Deliberately no cashier/seller on the row:
   * online sales stay out of the sellers report and payroll %.
   */
  async complete(
    businessId: string,
    id: string,
    account: IAccount,
    tender?: Tender[] | null,
  ): Promise<OnlineOrderDetail & {shiftMissing: boolean}> {
    const actor = await this.actorOf(account);
    const order = await this.load(businessId, id);
    const due = dueOf(order);
    const lines = this.settleTender(tender, due);
    const prepaid = Number(order.prepaidAmount);

    const [shift] = await this.dbService.db
      .select({id: cashShifts.id})
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.businessId, businessId),
          eq(cashShifts.status, 'open'),
          eq(cashShifts.openedByCashierId, account.id),
        ),
      )
      .orderBy(desc(cashShifts.openedAt))
      .limit(1);
    const toLedger =
      prepaid > EPSILON || lines.some((l) => !!l.accountId) || !shift;

    // The sale's payment breakdown covers the whole order: deposits + now.
    const deposits =
      prepaid > EPSILON
        ? await this.dbService.db
            .select({
              method: orderPayments.method,
              amount: sql<string>`sum(${orderPayments.amount})`,
            })
            .from(orderPayments)
            .where(
              and(
                eq(orderPayments.orderId, id),
                eq(orderPayments.kind, 'deposit'),
              ),
            )
            .groupBy(orderPayments.method)
        : [];
    const breakdown = mergeTender([
      ...deposits.map((d) => ({method: d.method, amount: Number(d.amount)})),
      ...lines,
    ]);
    const methods = breakdown.map((p) => p.method);

    const now = new Date();
    const detail = await this.move(businessId, id, 'Completed', actor, {
      expectDue: due,
      within: toLedger
        ? async (tx) => {
            for (const l of lines) {
              await this.takeMoneyTx(tx, businessId, id, actor, {
                kind: 'balance',
                amount: l.amount,
                method: l.method,
                accountId: l.accountId ?? null,
              });
            }
            return {};
          }
        : undefined,
      set: {
        payments: toLedger ? breakdown : mergeTender(lines),
        paymentMethod:
          methods.length > 1 ? 'split' : (methods[0] ?? 'cash'),
        amountPaid: money(payableOf(order)),
        changeAmount: '0.00',
        shiftId: toLedger ? null : shift!.id,
        // Q13: the sale belongs to the day it was handed over; placedAt keeps
        // the moment the customer ordered.
        createdAt: now,
        placedAt: order.placedAt ?? order.createdAt,
      },
    });
    // Booked to Moliya when no shift was open, so nothing is left unrecorded.
    return {...detail, shiftMissing: false};
  }

  async cancel(
    businessId: string,
    id: string,
    account: IAccount,
    reason: StaffCancelReason,
    note?: string | null,
    deposit: 'refund' | 'keep' = 'refund',
  ) {
    if (!STAFF_CANCEL_REASONS.includes(reason)) {
      throw new AppException(ErrorCode.VALIDATION_ERROR);
    }
    const cleanNote = note?.trim() || null;
    if (reason === 'other' && !cleanNote) {
      throw new AppException(ErrorCode.ORDER_CANCEL_NOTE_REQUIRED);
    }
    const actor = await this.actorOf(account);
    return this.move(businessId, id, 'Cancelled', actor, {
      reason,
      note: cleanNote,
      restock: true,
      within: (tx, order) =>
        this.settleDepositOnCancelTx(tx, businessId, order, deposit, actor),
      set: {cancelReason: reason, cancelNote: cleanNote},
    });
  }

  /**
   * Trim an order while it is being assembled (Q16): lines only go down,
   * what comes off goes back on the shelf, the goods total follows. The
   * delivery fee stays what checkout fixed (Q23).
   */
  async updateItems(
    businessId: string,
    id: string,
    account: IAccount,
    input: {itemId: string; quantity: number}[],
  ): Promise<OnlineOrderDetail> {
    const actor = await this.actorOf(account);
    let changes: {name: string; from: number; to: number}[] = [];
    let updated: Order | null = null;

    await this.dbService.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, businessId, id);
      if (order.status !== 'Assembling' && order.status !== 'Awaiting') {
        throw new AppException(ErrorCode.ORDER_ITEMS_EDIT_NOT_ALLOWED);
      }
      const lines = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, id));
      const byId = new Map(lines.map((l) => [l.id, l]));

      const next = new Map(lines.map((l) => [l.id, l.quantity]));
      for (const {itemId, quantity} of input) {
        const line = byId.get(itemId);
        if (!line) throw new AppException(ErrorCode.ORDER_NOT_FOUND);
        if (!(quantity >= 0) || quantity > line.quantity + 1e-9) {
          throw new AppException(ErrorCode.ORDER_ITEM_QTY_INCREASE, {
            name: line.productName,
          });
        }
        next.set(itemId, quantity);
      }
      changes = lines
        .filter((l) => next.get(l.id)! < l.quantity - 1e-9)
        .map((l) => ({
          name: l.productName,
          from: l.quantity,
          to: next.get(l.id)!,
        }));
      if (changes.length === 0) return;
      if (lines.every((l) => next.get(l.id)! <= 1e-9)) {
        throw new AppException(ErrorCode.ORDER_ITEMS_ALL_REMOVED);
      }

      // Put the difference back, at the line's own cost/price snapshot.
      const back: (OrderItem & {restockFraction: number})[] = [];
      for (const line of lines) {
        const to = next.get(line.id)!;
        if (to >= line.quantity - 1e-9) continue;
        back.push({
          ...line,
          quantity: round2((line.quantity - to) * 1000) / 1000,
          restockFraction: (line.quantity - to) / line.quantity,
        });
      }
      await this.orderService.restockOrderLinesTx(
        tx,
        businessId,
        back,
        order.branchId,
      );

      const productIds = lines
        .map((l) => l.productId)
        .filter(Boolean) as string[];
      const types = new Map(
        (productIds.length
          ? await tx
              .select({id: products.id, quantityType: products.quantityType})
              .from(products)
              .where(inArray(products.id, productIds))
          : []
        ).map((p) => [p.id, p.quantityType]),
      );

      let subtotal = 0;
      let itemCount = 0;
      for (const line of lines) {
        const to = next.get(line.id)!;
        if (to <= 1e-9) {
          await tx.delete(orderItems).where(eq(orderItems.id, line.id));
          continue;
        }
        const ratio = to / line.quantity;
        const lineTotal = round2(Number(line.lineTotal) * ratio);
        subtotal += lineTotal;
        itemCount += itemCountOf(to, types.get(line.productId ?? '') ?? null);
        if (ratio < 1) {
          await tx
            .update(orderItems)
            .set({
              quantity: to,
              lineTotal: money(lineTotal),
              costTotal: money(Number(line.costTotal) * ratio),
            })
            .where(eq(orderItems.id, line.id));
        }
      }
      const total = Math.max(
        0,
        round2(subtotal - Number(order.discountAmount)),
      );
      // The deposit must still fit inside what the customer owes.
      const newPayable = round2(total + Number(order.deliveryFee));
      if (Number(order.prepaidAmount) > newPayable + EPSILON) {
        throw new AppException(ErrorCode.ORDER_DEPOSIT_TOO_LARGE, {
          max: money(newPayable),
        });
      }
      [updated] = await tx
        .update(orders)
        .set({
          subtotalAmount: money(subtotal),
          totalAmount: money(total),
          itemCount,
          // Nothing is paid before hand-over; keep the placeholder tender in
          // step with the goods total like checkout wrote it.
          payments: [{method: 'cash', amount: total}],
          amountPaid: money(total),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, id))
        .returning();
      await tx.insert(orderStatusEvents).values({
        id: generateId(),
        businessId,
        orderId: id,
        fromStatus: order.status,
        toStatus: order.status,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        meta: {changes},
      });
    });

    if (updated && changes.length)
      this.tellCustomer(updated, 'ItemsChanged', {changes});
    return this.detail(businessId, id);
  }

  // ── Online seller (ONLAYN-SOTUVCHI.md) ────────────────────────────────

  /**
   * Staff type in an order taken in a DM (Q3). It is born accepted: Awaiting
   * when a line is not on the shelf, else Assembling. Lines are priced at the
   * card; any card may go on it — "Buyurtmaga olinadi" only gates the shopper.
   * A deposit, when given, is taken right after in its own transaction (it
   * is validated against the card prices first, so it cannot be refused for
   * size once the order exists).
   */
  async createManual(
    businessId: string,
    account: IAccount,
    input: {
      items: {
        productId: string;
        quantity: number;
        options?: {name: string; value: string}[] | null;
      }[];
      customerName?: string | null;
      customerPhone?: string | null;
      deliveryType: 'pickup' | 'delivery';
      deliveryAddress?: string | null;
      deliveryFee?: number | null;
      channel?: OrderChannel | null;
      note?: string | null;
      deposit?: {amount: number; method: string; accountId?: string | null} | null;
    },
  ): Promise<OnlineOrderDetail> {
    if (!input.items.length) throw new AppException(ErrorCode.ORDER_EMPTY);
    const address = input.deliveryAddress?.trim() || null;
    if (input.deliveryType === 'delivery' && !address) {
      throw new AppException(ErrorCode.STORE_DELIVERY_ADDRESS_REQUIRED);
    }
    const fee = round2(Math.max(0, Number(input.deliveryFee) || 0));
    const actor = await this.actorOf(account);
    const branch = await this.storeSettings.onlineBranch(businessId);

    if (input.deposit && input.deposit.amount > 0) {
      const ids = [...new Set(input.items.map((i) => i.productId))];
      const cards = await this.dbService.db
        .select({id: products.id, priceOut: products.priceOut})
        .from(products)
        .where(and(eq(products.businessId, businessId), inArray(products.id, ids)));
      const price = new Map(cards.map((c) => [c.id, Number(c.priceOut)]));
      const payable = round2(
        input.items.reduce(
          (sum, i) => sum + (price.get(i.productId) ?? 0) * i.quantity,
          0,
        ) + fee,
      );
      if (input.deposit.amount > payable + EPSILON) {
        throw new AppException(ErrorCode.ORDER_DEPOSIT_TOO_LARGE, {
          max: money(payable),
        });
      }
    }

    const order = await this.orderService.create(businessId, {
      items: input.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
      })),
      customerName: input.customerName?.trim() || undefined,
      phone: input.customerPhone?.trim() || undefined,
      note: input.note?.trim() || undefined,
      source: 'store',
      branchId: branch.id,
      fulfilment: {
        deliveryType: input.deliveryType,
        address: input.deliveryType === 'delivery' ? address : null,
        deliveryFee: fee,
        locale: null,
      },
      online: {
        deferUnstocked: true,
        itemOptions: input.items.map((i) => cleanOptions(i.options)),
        manual: {
          channel: input.channel ?? null,
          actorType: actor.type === 'staff' ? 'staff' : 'owner',
          actorId: actor.id,
          actorName: actor.name,
        },
      },
    });

    if (input.deposit && input.deposit.amount > 0) {
      return this.addDeposit(businessId, order.id, account, input.deposit);
    }
    return this.detail(businessId, order.id);
  }

  /** A deposit ("zaklad") taken before hand-over, into a Moliya account (Q5). */
  async addDeposit(
    businessId: string,
    id: string,
    account: IAccount,
    input: {
      amount: number;
      method: string;
      accountId?: string | null;
      note?: string | null;
    },
  ): Promise<OnlineOrderDetail> {
    const actor = await this.actorOf(account);
    const amount = round2(Number(input.amount));
    const method = String(input.method ?? '').trim();
    if (!(amount > 0) || !method || method === 'debt') {
      throw new AppException(ErrorCode.VALIDATION_ERROR);
    }
    await this.dbService.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, businessId, id);
      if (order.status === 'Completed' || order.status === 'Cancelled') {
        throw new AppException(ErrorCode.ORDER_DEPOSIT_NOT_ALLOWED);
      }
      const max = round2(payableOf(order) - Number(order.prepaidAmount));
      if (amount > max + EPSILON) {
        throw new AppException(ErrorCode.ORDER_DEPOSIT_TOO_LARGE, {
          max: money(Math.max(0, max)),
        });
      }
      await this.takeMoneyTx(tx, businessId, id, actor, {
        kind: 'deposit',
        amount,
        method,
        accountId: input.accountId ?? null,
        note: input.note?.trim() || null,
      });
      await tx
        .update(orders)
        .set({
          prepaidAmount: money(Number(order.prepaidAmount) + amount),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, id));
      await tx.insert(orderStatusEvents).values({
        id: generateId(),
        businessId,
        orderId: id,
        fromStatus: order.status,
        toStatus: order.status,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        meta: {deposit: amount, method},
      });
    });
    return this.detail(businessId, id);
  }

  /**
   * What the waiting orders need, per product (Q6): the "Tovar keldi"
   * screen. Lines not drawn yet on orders that are new or waiting, against
   * the online branch's stock. No allocation — the seller decides.
   */
  async awaitingStock(businessId: string): Promise<{
    products: {
      productId: string;
      productName: string;
      image: string | null;
      quantityType: string | null;
      needed: number;
      available: number;
      missing: number;
      lastPriceIn: string | null;
      options: {label: string; quantity: number}[];
      orders: {
        id: string;
        receiptNo: number | null;
        customerName: string | null;
        quantity: number;
        status: string;
      }[];
    }[];
  }> {
    const branch = await this.storeSettings.onlineBranch(businessId);
    const rows = await this.dbService.db
      .select({
        productId: orderItems.productId,
        productName: orderItems.productName,
        quantity: orderItems.quantity,
        options: orderItems.options,
        orderId: orders.id,
        receiptNo: orders.receiptNo,
        customerName: orders.customerName,
        status: orders.status,
        placedAt: sql<Date>`coalesce(${orders.placedAt}, ${orders.createdAt})`,
        image: products.image,
        quantityType: products.quantityType,
        priceIn: products.priceIn,
        onHand: sql<number>`coalesce(${branchStock.quantity}, 0)::float8`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(
        branchStock,
        and(
          eq(branchStock.productId, orderItems.productId),
          eq(branchStock.branchId, branch.id),
        ),
      )
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.source, 'store'),
          inArray(orders.status, ['Pending', 'Awaiting']),
          eq(orderItems.stockPending, true),
        ),
      )
      .orderBy(
        asc(sql`coalesce(${orders.placedAt}, ${orders.createdAt})`),
        asc(orders.id),
      );

    type Row = Awaited<ReturnType<OnlineOrderService['awaitingStock']>>['products'][number];
    const byProduct = new Map<string, Row & {optionMap: Map<string, number>}>();
    for (const r of rows) {
      if (!r.productId) continue;
      let p = byProduct.get(r.productId);
      if (!p) {
        p = {
          productId: r.productId,
          productName: r.productName,
          image: r.image,
          quantityType: r.quantityType,
          needed: 0,
          available: Math.max(0, Number(r.onHand) || 0),
          missing: 0,
          lastPriceIn: Number(r.priceIn) > 0 ? r.priceIn : null,
          options: [],
          orders: [],
          optionMap: new Map(),
        };
        byProduct.set(r.productId, p);
      }
      p.needed = round3(p.needed + r.quantity);
      const label = (r.options ?? []).map((o) => o.value).join(' · ');
      if (label) p.optionMap.set(label, round3((p.optionMap.get(label) ?? 0) + r.quantity));
      const existing = p.orders.find((o) => o.id === r.orderId);
      if (existing) existing.quantity = round3(existing.quantity + r.quantity);
      else
        p.orders.push({
          id: r.orderId,
          receiptNo: r.receiptNo,
          customerName: r.customerName,
          quantity: r.quantity,
          status: r.status,
        });
    }
    return {
      products: [...byProduct.values()]
        .map(({optionMap, ...p}) => ({
          ...p,
          missing: round3(Math.max(0, p.needed - p.available)),
          options: [...optionMap].map(([label, quantity]) => ({label, quantity})),
        }))
        // What is still missing first, then by how much is needed.
        .sort((a, b) => b.missing - a.missing || b.needed - a.needed),
    };
  }

  /**
   * The goods for waiting orders arrived (Q6, Q9): received at the online
   * branch as an ordinary supplier-less receipt — cost in so'm or dollars,
   * cargo spread into it — and, when an account is named, paid from it in
   * full (a supplier payment: stock, not a P&L expense). The balance is
   * checked before anything is written, so a refused payment never leaves a
   * received document behind to be entered twice. Orders are not moved: the
   * reply lists which ones can now continue, and the seller continues them.
   */
  async receiveArrival(
    businessId: string,
    account: IAccount,
    input: {
      items: {productId: string; quantity: number; priceIn: number}[];
      currency?: 'UZS' | 'USD';
      usdRate?: number;
      extraCost?: number;
      accountId?: string;
      allowNegative?: boolean;
      note?: string;
    },
  ): Promise<{
    receiptId: string;
    totalCost: string;
    readyOrders: {id: string; receiptNo: number | null; customerName: string | null}[];
  }> {
    const currency = input.currency ?? 'UZS';
    const branch = await this.storeSettings.onlineBranch(businessId);
    if (input.accountId) {
      const expected = round2(
        input.items.reduce((sum, i) => sum + i.priceIn * i.quantity, 0) +
          Math.max(0, input.extraCost ?? 0),
      );
      await this.dbService.db.transaction((tx) =>
        this.finance.assertAccountCoversTx(
          tx,
          businessId,
          input.accountId!,
          currency,
          expected,
          input.allowNegative,
        ),
      );
    }
    const receipt = await this.receipts.create(
      businessId,
      {
        items: input.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          priceIn: i.priceIn,
        })),
        currency,
        usdRate: input.usdRate,
        extraCost: input.extraCost,
        branchId: branch.id,
        note: input.note?.trim() || 'Mahsulot keldi (onlayn buyurtmalar)',
      },
      account,
    );
    const total = Number(receipt.totalAmount);
    if (input.accountId && total > 0) {
      await this.receipts.addPayment(
        businessId,
        receipt.id,
        {accountId: input.accountId, amount: total, allowNegative: true},
        account,
      );
    }
    const ready = await this.dbService.db
      .select({
        id: orders.id,
        receiptNo: orders.receiptNo,
        customerName: orders.customerName,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.source, 'store'),
          inArray(orders.status, ['Pending', 'Awaiting']),
          stockReadySql,
        ),
      )
      .orderBy(asc(sql`coalesce(${orders.placedAt}, ${orders.createdAt})`));
    return {receiptId: receipt.id, totalCost: receipt.totalAmount, readyOrders: ready};
  }

  /** The old PUT /orders/:id/status, for a client still on the old flow. */
  async legacyStatus(
    businessId: string,
    id: string,
    status: string,
    account: IAccount,
  ) {
    const to = legacyTarget(status);
    if (to === 'Assembling') return this.accept(businessId, id, account);
    if (to === 'Completed') return this.complete(businessId, id, account, null);
    if (to === 'Cancelled')
      return this.cancel(businessId, id, account, 'other', '—');
    const order = await this.load(businessId, id);
    throw new AppException(ErrorCode.ORDER_STATUS_TRANSITION_INVALID, {
      from: order.status,
      to: status,
    });
  }

  // ── Storefront (public) ────────────────────────────────────────────────

  /** The customer cancels before the shop took the order (Q9). */
  async cancelByCustomer(businessId: string | null, id: string): Promise<void> {
    const [row] = await this.dbService.db
      .select({businessId: orders.businessId})
      .from(orders)
      .where(
        and(
          eq(orders.id, id),
          eq(orders.source, 'store'),
          ...(businessId ? [eq(orders.businessId, businessId)] : []),
        ),
      )
      .limit(1);
    if (!row) throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    const order = await this.load(row.businessId, id);
    const detail = await this.move(
      row.businessId,
      id,
      'Cancelled',
      {type: 'customer', id: null, name: order.customerName},
      {
        onlyFrom: ['Pending'],
        reason: CUSTOMER_CANCEL_REASON,
        restock: true,
        within: (tx, locked) =>
          this.settleDepositOnCancelTx(tx, row.businessId, locked, 'refund', {
            type: 'customer',
            id: null,
            name: order.customerName,
          }),
        set: {cancelReason: CUSTOMER_CANCEL_REASON, cancelNote: null},
      },
    );
    this.telegramNotify.notifyOnlineOrderCancelledByCustomer(row.businessId, {
      orderId: id,
      totalAmount: detail.payable,
      itemCount: detail.itemCount,
      customerName: detail.customerName,
      customerPhone: detail.customerPhone,
    });
  }

  /** Storefront projection of some orders, in the order of `ids`. */
  async storefrontViews(ids: string[]): Promise<StorefrontOrderView[]> {
    if (!ids.length) return [];
    const [rows, lines, events] = await Promise.all([
      this.dbService.db
        .select({
          order: orders,
          branchName: branches.name,
          branchAddress: branches.address,
        })
        .from(orders)
        .leftJoin(branches, eq(branches.id, orders.branchId))
        .where(and(inArray(orders.id, ids), eq(orders.source, 'store'))),
      this.dbService.db
        .select({
          orderId: orderItems.orderId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          lineTotal: orderItems.lineTotal,
          options: orderItems.options,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids)),
      this.dbService.db
        .select({
          orderId: orderStatusEvents.orderId,
          fromStatus: orderStatusEvents.fromStatus,
          toStatus: orderStatusEvents.toStatus,
          createdAt: orderStatusEvents.createdAt,
        })
        .from(orderStatusEvents)
        .where(inArray(orderStatusEvents.orderId, ids))
        .orderBy(asc(orderStatusEvents.createdAt)),
    ]);

    const byId = new Map(rows.map((r) => [r.order.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map(({order: o, branchName, branchAddress}) => {
        const type = deliveryTypeOf(o.deliveryType);
        const timeline = events
          .filter((e) => e.orderId === o.id && e.fromStatus !== e.toStatus)
          .map((e) => ({status: e.toStatus, at: e.createdAt}));
        if (!timeline.length) {
          timeline.push({status: 'Pending', at: o.placedAt ?? o.createdAt});
        }
        return {
          id: o.id,
          status: o.status,
          deliveryType: type,
          totalAmount: o.totalAmount,
          deliveryFee: o.deliveryFee,
          payable: money(payableOf(o)),
          itemCount: o.itemCount,
          createdAt: o.placedAt ?? o.createdAt,
          deliveryAddress: o.deliveryAddress,
          courier:
            o.status === 'Delivering' && o.courierName
              ? {name: o.courierName, phone: o.courierPhone}
              : null,
          pickup:
            type === 'pickup' && branchName
              ? {branchName, address: branchAddress}
              : null,
          cancelReason: o.cancelReason,
          cancelNote: o.cancelReason === 'other' ? o.cancelNote : null,
          canCancel: o.status === 'Pending',
          timeline,
          items: lines
            .filter((l) => l.orderId === o.id)
            .map(({productName, quantity, lineTotal, options}) => ({
              productName,
              quantity,
              lineTotal,
              options: options ?? null,
            })),
        };
      });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * One status move: re-checked under a row lock (two people pressing at
   * once), written with its history row, then told to the customer.
   */
  private async move(
    businessId: string,
    id: string,
    to: OnlineStatus,
    actor: Actor,
    opts: {
      onlyFrom?: OnlineStatus[];
      courierName?: string | null;
      reason?: string | null;
      note?: string | null;
      restock?: boolean;
      // complete(): the tender was settled against this — refuse if what is
      // due (goods, delivery, deposits) moved in between.
      expectDue?: number;
      // Extra writes in the same transaction, on the locked row; may add to
      // the row update.
      within?: (
        tx: DbTx,
        order: Order,
      ) => Promise<Partial<typeof orders.$inferInsert>>;
      set?: Partial<typeof orders.$inferInsert>;
    } = {},
  ): Promise<OnlineOrderDetail> {
    let updated: Order | null = null;
    let from: string | null = null;
    let drawn: string[] = [];
    await this.dbService.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, businessId, id);
      from = order.status;
      const type = deliveryTypeOf(order.deliveryType);
      if (
        opts.onlyFrom &&
        !opts.onlyFrom.includes(order.status as OnlineStatus)
      ) {
        throw new AppException(ErrorCode.STORE_ORDER_NOT_CANCELLABLE);
      }
      if (!canTransition(order.status, to, type)) {
        throw new AppException(ErrorCode.ORDER_STATUS_TRANSITION_INVALID, {
          from: order.status,
          to,
        });
      }
      if (
        opts.expectDue != null &&
        Math.abs(dueOf(order) - opts.expectDue) > EPSILON
      ) {
        throw new AppException(ErrorCode.ORDER_PAYMENT_MISMATCH, {
          expected: money(dueOf(order)),
        });
      }
      // Past Awaiting every line must be on the shelf (ONLAYN-SOTUVCHI.md Q1).
      if (needsStock(to)) {
        drawn = await this.orderService.drawPendingLinesTx(tx, businessId, order);
      }
      const extra = opts.within ? await opts.within(tx, order) : {};
      if (opts.restock) {
        const items = await tx
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, id));
        await this.orderService.restockOrderLinesTx(
          tx,
          businessId,
          items,
          order.branchId,
        );
      }
      [updated] = await tx
        .update(orders)
        .set({...opts.set, ...extra, status: to, updatedAt: new Date()})
        .where(eq(orders.id, id))
        .returning();
      await tx.insert(orderStatusEvents).values({
        id: generateId(),
        businessId,
        orderId: id,
        fromStatus: order.status,
        toStatus: to,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        courierName: opts.courierName ?? null,
        reason: opts.reason ?? null,
        note: opts.note ?? null,
      });
    });

    void this.orderService.settleWaitingPrices(businessId, drawn);
    if (updated)
      this.tellCustomer(
        updated,
        from === 'Awaiting' && to === 'Assembling' ? 'Arrived' : to,
      );
    return this.detail(businessId, id);
  }

  /**
   * One money movement on an order: into (deposit/balance) or out of
   * (refund) a Moliya account, plus its order_payments row. Inside `tx`.
   */
  private async takeMoneyTx(
    tx: DbTx,
    businessId: string,
    orderId: string,
    actor: Actor,
    input: {
      kind: 'deposit' | 'balance' | 'refund';
      amount: number;
      method: string;
      accountId?: string | null;
      note?: string | null;
    },
  ): Promise<void> {
    const account = await this.finance.orderAccountTx(
      tx,
      businessId,
      input.method,
      input.accountId,
    );
    const label =
      input.kind === 'deposit'
        ? "Oldindan to'lov"
        : input.kind === 'balance'
          ? "Buyurtma to'lovi"
          : "Oldindan to'lov qaytarildi";
    const txn = await this.finance.recordOrderMoneyTx(tx, businessId, account, {
      source: input.kind === 'refund' ? 'order_refund' : 'order_payment',
      amount: input.amount,
      note: `${label} · #${orderId.slice(0, 8).toUpperCase()}`,
      cashierId: actor.id,
      cashierName: actor.name,
    });
    await tx.insert(orderPayments).values({
      id: generateId(),
      businessId,
      orderId,
      kind: input.kind,
      amount: money(input.amount),
      method: input.method,
      accountId: account.id,
      accountName: account.name,
      financeTxId: txn.id,
      actorId: actor.id,
      actorName: actor.name,
      note: input.note ?? null,
    });
  }

  /**
   * The deposit when an order is cancelled (Q7): given back to the accounts
   * it came into, or kept as other income. Returns the row update.
   */
  private async settleDepositOnCancelTx(
    tx: DbTx,
    businessId: string,
    order: Order,
    choice: 'refund' | 'keep',
    actor: Actor,
  ): Promise<Partial<typeof orders.$inferInsert>> {
    if (Number(order.prepaidAmount) <= EPSILON) return {};
    const rows = await tx
      .select({
        kind: orderPayments.kind,
        amount: orderPayments.amount,
        method: orderPayments.method,
        accountId: orderPayments.accountId,
      })
      .from(orderPayments)
      .where(
        and(
          eq(orderPayments.orderId, order.id),
          inArray(orderPayments.kind, ['deposit', 'refund']),
        ),
      )
      .orderBy(asc(orderPayments.createdAt));
    // What each account still holds of this order's deposits.
    const held = new Map<string, {method: string; amount: number}>();
    for (const r of rows) {
      const key = r.accountId ?? '';
      const h = held.get(key) ?? {method: r.method, amount: 0};
      h.amount = round2(
        h.amount + (r.kind === 'deposit' ? 1 : -1) * Number(r.amount),
      );
      held.set(key, h);
    }
    for (const [accountId, h] of held) {
      if (h.amount <= EPSILON) continue;
      if (choice === 'refund') {
        await this.takeMoneyTx(tx, businessId, order.id, actor, {
          kind: 'refund',
          amount: h.amount,
          method: h.method,
          accountId: accountId || null,
        });
      } else {
        const account = await this.finance.orderAccountTx(
          tx,
          businessId,
          h.method,
          accountId || null,
        );
        await this.finance.recordKeptDepositTx(tx, businessId, account, {
          amount: h.amount,
          note: `#${order.id.slice(0, 8).toUpperCase()}`,
          cashierId: actor.id,
          cashierName: actor.name,
        });
      }
    }
    return choice === 'refund' ? {prepaidAmount: '0.00'} : {};
  }

  private paymentsOf(orderId: string): Promise<OrderPaymentView[]> {
    return this.dbService.db
      .select({
        id: orderPayments.id,
        kind: orderPayments.kind,
        amount: orderPayments.amount,
        method: orderPayments.method,
        accountId: orderPayments.accountId,
        accountName: orderPayments.accountName,
        actorName: orderPayments.actorName,
        note: orderPayments.note,
        createdAt: orderPayments.createdAt,
      })
      .from(orderPayments)
      .where(eq(orderPayments.orderId, orderId))
      .orderBy(asc(orderPayments.createdAt), asc(orderPayments.id));
  }

  private async lockOrder(
    tx: DbTx,
    businessId: string,
    id: string,
  ): Promise<Order> {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.id, id)))
      .for('update')
      .limit(1);
    if (!order) throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    if (order.source !== 'store')
      throw new AppException(ErrorCode.ORDER_NOT_ONLINE);
    return order;
  }

  private async load(businessId: string, id: string): Promise<OrderWithItems> {
    const order = await this.orderService.findOne(businessId, id);
    if (!order) throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    if (order.source !== 'store')
      throw new AppException(ErrorCode.ORDER_NOT_ONLINE);
    return order;
  }

  private events(orderId: string) {
    return this.dbService.db
      .select({
        id: orderStatusEvents.id,
        fromStatus: orderStatusEvents.fromStatus,
        toStatus: orderStatusEvents.toStatus,
        actorType: orderStatusEvents.actorType,
        actorName: orderStatusEvents.actorName,
        courierName: orderStatusEvents.courierName,
        reason: orderStatusEvents.reason,
        note: orderStatusEvents.note,
        createdAt: orderStatusEvents.createdAt,
      })
      .from(orderStatusEvents)
      .where(eq(orderStatusEvents.orderId, orderId))
      .orderBy(asc(orderStatusEvents.createdAt), asc(orderStatusEvents.id));
  }

  private async actorOf(account: IAccount): Promise<Actor> {
    const who = await this.orderService.resolveCashier(account);
    return {
      type: account.type === 'staff' ? 'staff' : 'owner',
      id: who.id,
      name: who.name,
    };
  }

  /** The completing tender: full cash by default; never debt; must cover
   *  exactly what is still due (goods + delivery − deposits). Nothing due →
   *  nothing taken. */
  private settleTender(
    tender: Tender[] | null | undefined,
    due: number,
  ): Tender[] {
    const lines = (tender?.length ? tender : [{method: 'cash', amount: due}])
      .map((t) => ({
        method: String(t.method ?? '').trim(),
        amount: round2(Number(t.amount)),
        accountId: t.accountId || null,
      }))
      .filter((t) => t.amount > 0);
    if (due <= EPSILON && lines.length === 0) return [];
    if (lines.some((t) => !t.method || t.method === 'debt')) {
      throw new AppException(ErrorCode.VALIDATION_ERROR);
    }
    const sum = lines.reduce((s, t) => s + t.amount, 0);
    if (Math.abs(sum - due) > EPSILON || lines.length === 0) {
      throw new AppException(ErrorCode.ORDER_PAYMENT_MISMATCH, {
        expected: money(due),
      });
    }
    return lines;
  }

  private view(
    o: Order,
    movedAt: Date | null,
    stock: {pendingLines: number; stockReady: boolean} = {
      pendingLines: 0,
      stockReady: false,
    },
  ): OnlineOrderView {
    const placedAt = o.placedAt ?? o.createdAt;
    return {
      id: o.id,
      receiptNo: o.receiptNo,
      status: o.status,
      deliveryType: deliveryTypeOf(o.deliveryType),
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      deliveryAddress: o.deliveryAddress,
      deliveryLat: o.deliveryLat,
      deliveryLng: o.deliveryLng,
      note: o.note,
      totalAmount: o.totalAmount,
      deliveryFee: o.deliveryFee,
      payable: money(payableOf(o)),
      itemCount: o.itemCount,
      courierId: o.courierId,
      courierName: o.courierName,
      courierPhone: o.courierPhone,
      cancelReason: o.cancelReason,
      cancelNote: o.cancelNote,
      placedAt,
      statusChangedAt: movedAt ?? placedAt,
      createdAt: o.createdAt,
      prepaidAmount: o.prepaidAmount,
      balanceDue: money(dueOf(o)),
      channel: o.channel,
      pendingLines: stock.pendingLines,
      stockReady: stock.stockReady,
    };
  }

  /** Telegram DM to the shopper, when the order came from the mini app. */
  private tellCustomer(
    o: Order,
    kind: StoreOrderMessageKind | OnlineStatus,
    extra: {changes?: {name: string; from: number; to: number}[]} = {},
  ): void {
    if (!o.telegramUserId || kind === 'Pending') return;
    const send = (pickup?: {name: string; address: string | null}) =>
      this.telegramNotify.notifyStoreOrderStatus(o.businessId, {
        telegramUserId: o.telegramUserId!,
        kind: kind as StoreOrderMessageKind,
        locale: o.locale,
        orderId: o.id,
        deliveryType: deliveryTypeOf(o.deliveryType),
        itemCount: o.itemCount,
        totalAmount: o.totalAmount,
        deliveryFee: o.deliveryFee,
        courierName: o.courierName,
        courierPhone: o.courierPhone,
        pickupBranchName: pickup?.name ?? null,
        pickupAddress: pickup?.address ?? null,
        cancelReason: o.cancelReason,
        cancelNote: o.cancelNote,
        changes: extra.changes,
        prepaidAmount: o.prepaidAmount,
      });
    if (kind !== 'ReadyForPickup' || !o.branchId) return send();
    void this.dbService.db
      .select({name: branches.name, address: branches.address})
      .from(branches)
      .where(eq(branches.id, o.branchId))
      .limit(1)
      .then(([b]) => send(b))
      .catch(() => send());
  }
}
