// The storefront order state machine (YETKAZISH.md §2). Pure — unit-tested in
// online-order.rules.spec.ts.
//
//   Pending ─┬─> Awaiting ─> Assembling ─┬─> Delivering      (delivery) ─┬─> Completed
//            │                           └─> ReadyForPickup  (pickup)   ─┘
//            └─> (any later step, skipping is allowed — Q7)
//
// Awaiting ("Tovar kutilmoqda", ONLAYN-SOTUVCHI.md §2): taken, but at least
// one line is not drawn from stock yet. Moving past it draws those lines.
//   every non-final step ──> Cancelled (with a reason — Q8)
//
// Never backwards: the customer was already told, and a completed order has
// moved money into a shift.

export type OnlineStatus =
  | 'Pending'
  | 'Awaiting'
  | 'Assembling'
  | 'Delivering'
  | 'ReadyForPickup'
  | 'Completed'
  | 'Cancelled';

export type DeliveryType = 'pickup' | 'delivery';

export const ONLINE_GROUPS = {
  new: ['Pending'],
  awaiting: ['Awaiting'],
  inwork: ['Assembling', 'Delivering', 'ReadyForPickup'],
  active: ['Awaiting', 'Assembling', 'Delivering', 'ReadyForPickup'],
  done: ['Completed'],
  cancelled: ['Cancelled'],
} as const satisfies Record<string, readonly OnlineStatus[]>;

export type OnlineGroup = keyof typeof ONLINE_GROUPS | 'all';

/** Statuses an order has stock out for but is not a sale yet. */
export const IN_PROGRESS_STATUSES: readonly OnlineStatus[] = [
  'Pending',
  'Awaiting',
  'Assembling',
  'Delivering',
  'ReadyForPickup',
];

/** Reasons staff pick from; `customer_cancelled` is written only by the
 *  storefront's own cancel endpoint. */
export const STAFF_CANCEL_REASONS = [
  'customer_refused',
  'no_answer',
  'out_of_stock',
  'other',
] as const;
export type StaffCancelReason = (typeof STAFF_CANCEL_REASONS)[number];
export const CUSTOMER_CANCEL_REASON = 'customer_cancelled';

const RANK: Record<OnlineStatus, number> = {
  Pending: 0,
  Awaiting: 1,
  Assembling: 2,
  Delivering: 3,
  ReadyForPickup: 3,
  Completed: 4,
  Cancelled: 4,
};

/** Statuses whose lines must all be drawn from stock (anything past Awaiting). */
export function needsStock(to: OnlineStatus): boolean {
  return RANK[to] >= RANK.Assembling && to !== 'Cancelled';
}

export const ORDER_CHANNELS = ['instagram', 'telegram', 'other'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

/** A storefront order with no delivery_type predates delivery: pickup. */
export function deliveryTypeOf(raw: string | null | undefined): DeliveryType {
  return raw === 'delivery' ? 'delivery' : 'pickup';
}

export function isOnlineStatus(s: string): s is OnlineStatus {
  return s in RANK;
}

/** May an order of this fulfilment type move from `from` to `to`? */
export function canTransition(
  from: string,
  to: OnlineStatus,
  type: DeliveryType,
): boolean {
  if (!isOnlineStatus(from)) return false;
  if (from === 'Completed' || from === 'Cancelled') return false;
  if (to === 'Cancelled') return true;
  if (to === 'Delivering' && type !== 'delivery') return false;
  if (to === 'ReadyForPickup' && type !== 'pickup') return false;
  return RANK[to] > RANK[from];
}

/** Map an old status value (PUT /orders/:id/status) onto the new flow. */
export function legacyTarget(status: string): OnlineStatus | null {
  if (status === 'Confirmed' || status === 'Assembling') return 'Assembling';
  if (status === 'Completed' || status === 'Cancelled') return status;
  return null;
}

/** Delivery fee for a goods subtotal under the shop's settings (Q4, Q23). */
export function deliveryFeeFor(
  subtotal: number,
  settings: {deliveryFee: number; freeDeliveryFrom: number | null},
): number {
  if (
    settings.freeDeliveryFrom != null &&
    subtotal >= settings.freeDeliveryFrom
  ) {
    return 0;
  }
  return Math.max(0, settings.deliveryFee);
}
