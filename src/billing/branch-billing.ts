// Per-store billing state (FILIAL-OBUNA.md). One shared balance and one
// renewal date stay; each extra store carries its own state on top:
//
//   opened ──3 days──▶ free over ──balance covers──▶ paid (to the common date)
//    (free)                │
//                          └─short─▶ warning ──3 days──▶ closed
//
// The main (default) store follows the plan; the whole shop locks with it.

import {GRACE_DAYS, asDate} from './billing';

const DAY_MS = 86_400_000;

/** A new store is free for its first days, balance or not (Q1, FILIAL-OBUNA.md §3). */
export const BRANCH_FREE_DAYS = 3;
export const BRANCH_FREE_MS = BRANCH_FREE_DAYS * DAY_MS;

/** Days a due store keeps working, with a warning, before it closes. */
export const BRANCH_WARNING_DAYS = GRACE_DAYS;
const BRANCH_WARNING_MS = BRANCH_WARNING_DAYS * DAY_MS;

/**
 * - main:    the default store — billed with the plan, locks with the shop;
 * - covered: the subscription pays for every store (trial, admin open-ended);
 * - free:    in its first days;
 * - paid:    settled up to the current period's end;
 * - warning: due and unpaid, still working until `closesAt`;
 * - closed:  read-only until paid.
 */
export type BranchBillingState =
  | 'main'
  | 'covered'
  | 'free'
  | 'paid'
  | 'warning'
  | 'closed';

export interface BranchBillingRow {
  isDefault: boolean;
  createdAt: Date | string;
  freeUntil: Date | string | null;
  paidUntil: Date | string | null;
  renew: boolean;
}

export interface BranchBillingSub {
  endDate: Date | string | null;
  isTrial: boolean;
}

export interface BranchBillingVerdict {
  state: BranchBillingState;
  /** Free or paid up to here (free / paid). */
  until: Date | null;
  /** When a store in warning closes. */
  closesAt: Date | null;
}

const time = (d: Date | string | null | undefined): number | null =>
  d == null ? null : asDate(d).getTime();

/**
 * Where a store stands. Paid means paid through the current period's end —
 * which keeps a store open while the shop's own renewal is pending past that
 * end (the shop-level stage covers that window). A store the owner stopped
 * renewing closes at once when its paid time runs out: no warning days.
 */
export function branchBillingState(
  branch: BranchBillingRow,
  sub: BranchBillingSub | null,
  now: Date,
): BranchBillingVerdict {
  const none = {until: null, closesAt: null};
  if (branch.isDefault) return {state: 'main', ...none};
  if (!sub || sub.endDate == null || sub.isTrial) {
    return {state: 'covered', ...none};
  }
  const t = now.getTime();
  const free = time(branch.freeUntil);
  if (free != null && t < free) {
    return {state: 'free', until: new Date(free), closesAt: null};
  }
  const paid = time(branch.paidUntil);
  const end = time(sub.endDate)!;
  if (paid != null && paid >= end) {
    return {state: 'paid', until: new Date(paid), closesAt: null};
  }
  if (!branch.renew) return {state: 'closed', ...none};
  // Due since its free days or its last paid time ran out.
  const dueSince = Math.max(free ?? 0, paid ?? 0, time(branch.createdAt)!);
  const closesAt = dueSince + BRANCH_WARNING_MS;
  return t < closesAt
    ? {state: 'warning', until: null, closesAt: new Date(closesAt)}
    : {state: 'closed', ...none};
}

/** True when the store's stock must not change. */
export function isBranchClosed(
  branch: BranchBillingRow,
  sub: BranchBillingSub | null,
  now: Date,
): boolean {
  return branchBillingState(branch, sub, now).state === 'closed';
}

/**
 * How many of the renewing stores a renewal takes, and for which cycle
 * (FILIAL-OBUNA.md §3, Q9). `totalFor(k)` is the month's total with k extra
 * stores. Nothing renews when the balance is short of the plan alone — the
 * whole shop then goes into its own grace (Q2). A wanted year needs the year
 * for the plan and every renewing store; otherwise a month, with as many
 * stores as the balance covers, oldest first (the caller orders them).
 */
export function fitRenewal(input: {
  balance: number;
  candidates: number;
  totalFor: (extraStores: number) => number;
  cycleWanted: 'month' | 'year';
  yearTotal: (monthly: number) => number;
}): {renews: false} | {renews: true; stores: number; cycle: 'month' | 'year'} {
  const {balance, candidates, totalFor} = input;
  if (balance < totalFor(0)) return {renews: false};
  if (
    input.cycleWanted === 'year' &&
    balance >= input.yearTotal(totalFor(candidates))
  ) {
    return {renews: true, stores: candidates, cycle: 'year'};
  }
  let stores = candidates;
  while (stores > 0 && totalFor(stores) > balance) stores--;
  return {renews: true, stores, cycle: 'month'};
}
