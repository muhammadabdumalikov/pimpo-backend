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
  branches,
  cashShifts,
  orderItems,
  orderStatusEvents,
  orders,
  products,
  staff,
  type Order,
  type OrderItem,
} from '../database/schema';
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
  type OnlineGroup,
  type OnlineStatus,
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
  }[];
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
  items: {productName: string; quantity: number; lineTotal: string}[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => round2(n).toFixed(2);
// Money is stored to 2dp; anything below this is rounding, not a mismatch.
const EPSILON = 0.5;

const payableOf = (o: Pick<Order, 'totalAmount' | 'deliveryFee'>) =>
  round2(Number(o.totalAmount) + Number(o.deliveryFee));

// Latest status move of an order — the "waiting since" of the list.
const lastMoveAt = sql<Date | null>`(SELECT max(e.created_at) FROM order_status_events e WHERE e.order_id = ${orders.id}) AT TIME ZONE 'UTC'`;

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
      .select({order: orders, movedAt: lastMoveAt})
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
      orders: rows.map((r) => this.view(r.order, r.movedAt)),
      total,
      page,
      limit,
    };
  }

  async counts(businessId: string): Promise<{new: number; active: number}> {
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
    return {
      new: by.get('Pending') ?? 0,
      active: ONLINE_GROUPS.active.reduce(
        (sum, s) => sum + (by.get(s) ?? 0),
        0,
      ),
    };
  }

  async detail(businessId: string, id: string): Promise<OnlineOrderDetail> {
    const order = await this.load(businessId, id);
    const [lines, events, branch] = await Promise.all([
      this.dbService.db
        .select({
          id: orderItems.id,
          productId: orderItems.productId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          priceOut: orderItems.priceOut,
          lineTotal: orderItems.lineTotal,
          quantityType: products.quantityType,
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
    ]);
    const movedAt = events.length ? events[events.length - 1].createdAt : null;
    return {
      ...this.view(order, movedAt),
      items: lines,
      events,
      payments:
        (order.payments as {method: string; amount: number}[] | null) ?? null,
      paymentMethod: order.paymentMethod,
      shiftId: order.shiftId,
      branchName: branch[0]?.name ?? null,
    };
  }

  // ── Staff actions ──────────────────────────────────────────────────────

  async accept(businessId: string, id: string, account: IAccount) {
    return this.move(businessId, id, 'Assembling', await this.actorOf(account));
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
   * Hand-over: the money is taken now (Q11), into the completing account's
   * open shift (Q12), and the order becomes a sale dated today (Q13).
   * Deliberately no cashier/seller on the row: online sales stay out of the
   * sellers report and payroll %, as they always were.
   */
  async complete(
    businessId: string,
    id: string,
    account: IAccount,
    tender?: {method: string; amount: number}[] | null,
  ): Promise<OnlineOrderDetail & {shiftMissing: boolean}> {
    const actor = await this.actorOf(account);
    const order = await this.load(businessId, id);
    const payable = payableOf(order);
    const payments = this.settleTender(tender, payable);
    const methods = Array.from(new Set(payments.map((p) => p.method)));

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

    const now = new Date();
    const detail = await this.move(businessId, id, 'Completed', actor, {
      expectPayable: payable,
      set: {
        payments,
        paymentMethod: methods.length > 1 ? 'split' : methods[0],
        amountPaid: money(payable),
        changeAmount: '0.00',
        shiftId: shift?.id ?? null,
        // Q13: the sale belongs to the day it was handed over; placedAt keeps
        // the moment the customer ordered.
        createdAt: now,
        placedAt: order.placedAt ?? order.createdAt,
      },
    });
    return {...detail, shiftMissing: !shift};
  }

  async cancel(
    businessId: string,
    id: string,
    account: IAccount,
    reason: StaffCancelReason,
    note?: string | null,
  ) {
    if (!STAFF_CANCEL_REASONS.includes(reason)) {
      throw new AppException(ErrorCode.VALIDATION_ERROR);
    }
    const cleanNote = note?.trim() || null;
    if (reason === 'other' && !cleanNote) {
      throw new AppException(ErrorCode.ORDER_CANCEL_NOTE_REQUIRED);
    }
    return this.move(businessId, id, 'Cancelled', await this.actorOf(account), {
      reason,
      note: cleanNote,
      restock: true,
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
      if (order.status !== 'Assembling') {
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
        fromStatus: 'Assembling',
        toStatus: 'Assembling',
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
            .map(({productName, quantity, lineTotal}) => ({
              productName,
              quantity,
              lineTotal,
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
      // complete(): the tender was settled against this — refuse if the
      // goods total moved in between.
      expectPayable?: number;
      set?: Partial<typeof orders.$inferInsert>;
    } = {},
  ): Promise<OnlineOrderDetail> {
    let updated: Order | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, businessId, id);
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
        opts.expectPayable != null &&
        Math.abs(payableOf(order) - opts.expectPayable) > EPSILON
      ) {
        throw new AppException(ErrorCode.ORDER_PAYMENT_MISMATCH, {
          expected: money(payableOf(order)),
        });
      }
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
        .set({...opts.set, status: to, updatedAt: new Date()})
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

    if (updated) this.tellCustomer(updated, to);
    return this.detail(businessId, id);
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
   *  exactly what the customer owes (goods + delivery). */
  private settleTender(
    tender: {method: string; amount: number}[] | null | undefined,
    payable: number,
  ): {method: string; amount: number}[] {
    const lines = (
      tender?.length ? tender : [{method: 'cash', amount: payable}]
    )
      .map((t) => ({
        method: String(t.method ?? '').trim(),
        amount: round2(Number(t.amount)),
      }))
      .filter((t) => t.amount > 0);
    if (lines.some((t) => !t.method || t.method === 'debt')) {
      throw new AppException(ErrorCode.VALIDATION_ERROR);
    }
    const sum = lines.reduce((s, t) => s + t.amount, 0);
    if (Math.abs(sum - payable) > EPSILON || lines.length === 0) {
      throw new AppException(ErrorCode.ORDER_PAYMENT_MISMATCH, {
        expected: money(payable),
      });
    }
    // Merge repeats of one method so the shift reads one figure per method.
    const merged = new Map<string, number>();
    for (const t of lines)
      merged.set(t.method, round2((merged.get(t.method) ?? 0) + t.amount));
    return Array.from(merged, ([method, amount]) => ({method, amount}));
  }

  private view(o: Order, movedAt: Date | null): OnlineOrderView {
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
