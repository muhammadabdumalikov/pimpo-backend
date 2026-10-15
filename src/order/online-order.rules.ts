// The storefront order state machine (YETKAZISH.md §2). Pure — unit-tested in
// online-order.rules.spec.ts.
//
//   Pending ─┬─> Assembling ─┬─> Delivering      (delivery) ─┬─> Completed
//            │               └─> ReadyForPickup  (pickup)   ─┘
//            └─> (any later step, skipping is allowed — Q7)
//   every non-final step ──> Cancelled (with a reason — Q8)
//
// Never backwards: the customer was already told, and a completed order has
// moved money into a shift.

export type OnlineStatus =
  | 'Pending'
  | 'Assembling'
  | 'Delivering'
  | 'ReadyForPickup'
  | 'Completed'
  | 'Cancelled';

export type DeliveryType = 'pickup' | 'delivery';

export const ONLINE_GROUPS = {
  new: ['Pending'],
  active: ['Assembling', 'Delivering', 'ReadyForPickup'],
  done: ['Completed'],
  cancelled: ['Cancelled'],
} as const satisfies Record<string, readonly OnlineStatus[]>;

export type OnlineGroup = keyof typeof ONLINE_GROUPS | 'all';

/** Statuses an order has stock out for but is not a sale yet. */
export const IN_PROGRESS_STATUSES: readonly OnlineStatus[] = [
  'Pending',
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
  Assembling: 1,
  Delivering: 2,
  ReadyForPickup: 2,
  Completed: 3,
  Cancelled: 3,
};

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
