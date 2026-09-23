// Pure policy for the price a till QUOTED on a sale line — no DB, unit-tested
// in quoted-price.spec.ts.
//
// Why it exists: the screen and the receipt used to be able to disagree. The
// customer agreed to the figure on the screen; the paper should say the same.
// So the till sends what it quoted and the line is written at that price.
//
// It is not taken on trust — a client that can name a price can name any price.
// The shop's price is the one on the product card (or the wholesale/bundle tier
// the cashier picked), so that is the only figure a quote may carry. A quote
// that differs is a screen reading a price the shop has since changed, and the
// sale is refused rather than rung up at a figure nobody set: the till re-reads
// the card, shows the cashier the new price, and the line is rung again.
//
// This used to be a band rather than an equality, because every lot carried a
// selling price of its own and a line could legitimately be worth anything
// between the cheapest and the dearest lot it drew on. Lots no longer price
// anything — their priceOut is the delivery note's record — so the band has
// collapsed to the single price the card names.
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
  /** What this line is worth at the shop's own price, from consumeBatches. */
  lineRevenue: number;
  /**
   * The shop's price for this line right now: the product card's selling price,
   * or the tier price when one was chosen. Ignored when it is zero or missing —
   * a card with no price says nothing, and folding a 0 in would let a line be
   * quoted at nothing.
   */
  cardPrice?: number | null;
  /** Named in the error, so the cashier knows which line to look at. */
  productName: string;
  /**
   * False for an offline sale being replayed. That sale already happened at
   * the counter and refusing it here would drop it out of the books, so an
   * unbacked quote is dropped instead of the sale: the line falls back to the
   * card price. Nothing unbacked is ever written either way.
   */
  strict: boolean;
}

export interface LinePrice {
  revenueTotal: number;
  priceOut: number;
}

export function resolveLinePrice(input: QuotedPriceInput): LinePrice {
  const {quoted, quantity, lineRevenue} = input;
  const cardUnitPrice = quantity > 0 ? round2(lineRevenue / quantity) : 0;

  if (quoted == null) {
    return {revenueTotal: lineRevenue, priceOut: cardUnitPrice};
  }

  const card =
    input.cardPrice != null && input.cardPrice > 0 ? input.cardPrice : null;
  const expected = card ?? cardUnitPrice;

  if (Math.abs(quoted - expected) > EPSILON) {
    if (!input.strict) {
      return {revenueTotal: lineRevenue, priceOut: cardUnitPrice};
    }
    throw new AppException(ErrorCode.ORDER_PRICE_NOT_BACKED, {
      name: input.productName,
      quoted: money(quoted),
      expected: money(expected),
    });
  }

  // Inside the rounding tolerance: the card price is what the books record, so
  // a quote half a so'm off does not travel into the receipt.
  return {
    revenueTotal: lineRevenue,
    priceOut: cardUnitPrice,
  };
}
