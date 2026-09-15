// Pure policy for the price a till QUOTED on a sale line — no DB, unit-tested
// in quoted-price.spec.ts.
//
// Why it exists: the screen and the receipt used to be able to disagree. The
// till prices a cart from the product card, while the sale is valued by
// consuming lots oldest-first — so a line that runs past the end of the front
// lot is charged a blend of two prices the cashier was never shown, and a card
// price that moved while the cart sat open is charged at the new one. The
// customer agreed to the figure on the screen; the paper should say the same.
//
// So the till sends what it quoted and the receipt is written at that price.
// It is not taken on trust, which is the whole difficulty: a client that can
// name a price can name any price. The bound is the goods themselves — a
// quoted price is honoured only when the lots this line actually drew on carry
// it, somewhere between the cheapest and the dearest of them. A price inside
// that band is one the shop really put on these units; one outside it is a
// stale screen or a client inventing a figure, and is refused so the cashier
// re-rings it with prices that are real.
//
// Stock and COGS are untouched by any of this: the lots are consumed the same
// way whatever the line is sold for, so margin reporting stays honest.

import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';

/** Prices carry two decimals; below half a so'm is rounding, not a difference. */
const EPSILON = 0.5;

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toFixed(2);

export interface QuotedPriceInput {
  /** What the till showed per unit, or null/undefined when it said nothing. */
  quoted?: number | null;
  quantity: number;
  /** What the lots charge for this line, from consumeBatches. */
  batchRevenue: number;
  batchUnitPrice: number;
  /** The band those lots support (consumeBatches: min/maxLotPriceOut). */
  minLotPrice: number;
  maxLotPrice: number;
  /** Named in the error, so the cashier knows which line to look at. */
  productName: string;
  /**
   * False for an offline sale being replayed. That sale already happened at
   * the counter and refusing it here would drop it out of the books, so an
   * unbacked quote is dropped instead of the sale: the line falls back to what
   * the lots say. Nothing unbacked is ever written either way.
   */
  strict: boolean;
}

export interface LinePrice {
  revenueTotal: number;
  priceOut: number;
}

export function resolveLinePrice(input: QuotedPriceInput): LinePrice {
  const {quoted, quantity, batchRevenue, batchUnitPrice} = input;

  if (quoted == null) {
    return {revenueTotal: batchRevenue, priceOut: batchUnitPrice};
  }

  if (
    quoted < input.minLotPrice - EPSILON ||
    quoted > input.maxLotPrice + EPSILON
  ) {
    if (!input.strict) {
      return {revenueTotal: batchRevenue, priceOut: batchUnitPrice};
    }
    throw new AppException(ErrorCode.ORDER_PRICE_NOT_BACKED, {
      name: input.productName,
      quoted: money(quoted),
      expected: money(batchUnitPrice),
    });
  }

  return {
    revenueTotal: round2(quoted * quantity),
    priceOut: round2(quoted),
  };
}
