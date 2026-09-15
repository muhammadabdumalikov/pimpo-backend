// Pure reconciliation of a sale's tender against its total — no DB, unit-tested
// in payment-reconcile.spec.ts.
//
// Why it exists: the two numbers are not the same by construction. The till
// prices a cart from the product card; the sale is priced by consuming batches,
// and a line can span lots at different selling prices — so the receipt can
// settle a few so'm either side of the figure the cashier was quoted. The tender
// used to be written down verbatim, which turned that gap into a cash-drawer
// error nobody was told about: a 20 000 note handed over for an 18 524 sale was
// booked as 20 000 of takings, and the 1 476 that went back as change surfaced
// as a shortfall when the shift was counted.
//
// Rules:
//  - Cash above the total is CHANGE, not revenue: the tender is booked at what
//    the sale needed, the note stays in `amountPaid`, the rest is the change.
//  - A card gives no change, so a non-cash tender over the total is refused.
//  - A sale short of its total is a debt, which is its own document, so it is
//    refused too — while the cashier is still at the counter and can re-ring it.
//  - `strict: false` is for an offline sale being synced: it already happened
//    and the money is in the drawer, so it is recorded rather than refused. The
//    cash is still clamped — clamping only moves a figure toward the truth.

import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';

/** Money is stored to 2dp and the till rounds what it shows; below this is
 *  rounding, not a disagreement. */
const EPSILON = 0.5;

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toFixed(2);

export interface TenderLine {
  method: string;
  amount: number;
}

export interface ReconcileInput {
  /** The sale's total less any loyalty points spent — what real tenders cover. */
  payable: number;
  /** What the till says was handed over, per method. */
  payments: TenderLine[];
  /** Cash physically tendered, when the till reports it separately. */
  tendered?: number;
  /** False only for an offline sale being replayed (never refuse it). */
  strict: boolean;
}

export interface ReconcileResult {
  /** The tenders as they should be booked (cash clamped to what was needed). */
  payments: TenderLine[];
  /** Cash physically handed over — the note, not what the sale needed. */
  amountPaid: number;
  /** What went back to the customer. */
  changeAmount: number;
}

export function reconcilePayments(input: ReconcileInput): ReconcileResult {
  const {payable, payments, tendered, strict} = input;

  const applied = payments.reduce((sum, p) => sum + p.amount, 0);
  const cashIn = payments
    .filter((p) => p.method === 'cash')
    .reduce((sum, p) => sum + p.amount, 0);
  const nonCash = applied - cashIn;

  if (strict) {
    if (nonCash > payable + EPSILON) {
      throw new AppException(ErrorCode.ORDER_NON_CASH_EXCEEDS_TOTAL, {
        expected: money(payable),
        received: money(nonCash),
      });
    }
    if (applied < payable - EPSILON) {
      throw new AppException(ErrorCode.ORDER_UNDERPAID, {
        expected: money(payable),
        received: money(applied),
      });
    }
  }

  // What the cash has to cover once the other tenders are in. Taken off the
  // cash rows in order, so a split that names cash twice still adds up.
  let cashLeft = Math.max(0, Math.min(cashIn, payable - nonCash));
  const settled = payments
    .map((p) => {
      if (p.method !== 'cash') return p;
      const booked = Math.min(p.amount, cashLeft);
      cashLeft = round2(cashLeft - booked);
      return {...p, amount: round2(booked)};
    })
    .filter((p) => p.amount > 0);

  const cashBooked = settled
    .filter((p) => p.method === 'cash')
    .reduce((sum, p) => sum + p.amount, 0);
  // The note handed over: what the till reported, or the cash rows themselves
  // when it reported nothing. Never less than what was booked.
  const handedOver = Math.max(tendered ?? cashIn, cashBooked);

  return {
    payments: settled,
    amountPaid: round2(handedOver),
    changeAmount: round2(Math.max(0, handedOver - cashBooked)),
  };
}
