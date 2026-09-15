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
// name a price can name any price. The bound is the prices the SHOP has really
// put on these goods — the lots this line drew on, and the product card as it
// stands now. A quote anywhere between the cheapest and the dearest of those is
// honoured; one outside is a stale screen or a client inventing a figure, and
// is refused so the cashier re-rings it with prices that are real.
//
// The card price has to count, or the shop cannot reprice without a delivery.
// Raising the card price of something already on the shelf leaves lots wearing
// the old figure: the till shows the new price, no lot carries it, and every
// sale of that line is refused until a fresh delivery arrives. That is not a
// mispriced sale, it is the ordinary way a shop puts its prices up — and the
// figure the customer agreed to is one the shop set itself.
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
  /**
   * The product card's sale price right now — a price the shop set, so it
   * widens the band even when no lot has caught up with it yet. Ignored when
   * it is zero or missing: a card with no price says nothing, and folding a 0
   * in would let a line be quoted at nothing.
   */
  cardPrice?: number | null;
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

  const card =
    input.cardPrice != null && input.cardPrice > 0 ? input.cardPrice : null;
  const lo = card == null ? input.minLotPrice : Math.min(input.minLotPrice, card);
  const hi = card == null ? input.maxLotPrice : Math.max(input.maxLotPrice, card);

  if (quoted < lo - EPSILON || quoted > hi + EPSILON) {
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
