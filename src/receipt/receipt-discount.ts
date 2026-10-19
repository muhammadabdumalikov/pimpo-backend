// Receipt-level supplier discount ("Скидка" under a nakladnoy's lines).
//
// The discount is one figure for the whole document; the cost of every unit
// carries its share of it. It is spread pro rata to each line's printed value,
// so every line comes down by the same fraction: a 10% discount makes a
// 1 000 000 line cost 900 000. The printed prices stay on the document — the
// net cost is what lots, averages, returns and reports are valued at.

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface DiscountInput {
  discountAmount?: number | null;
  discountPct?: number | null;
}

export interface ResolvedDiscount {
  /** The amount taken off the gross, in the receipt currency. */
  amount: number;
  /** The percent it was typed as, while the percent drives; else null. */
  pct: number | null;
}

/**
 * The discount a payload asks for, against the lines' gross. A percent drives
 * when given — the amount is re-derived from it, so it follows the lines on
 * every edit. Otherwise the typed amount stands as it is.
 */
export function resolveDiscount(
  gross: number,
  input: DiscountInput,
): ResolvedDiscount {
  const pct = input.discountPct;
  if (pct != null && pct > 0) {
    return {amount: round2((gross * pct) / 100), pct};
  }
  if (pct != null) return {amount: 0, pct: null};
  const amount = input.discountAmount;
  return {amount: amount != null && amount > 0 ? round2(amount) : 0, pct: null};
}

/**
 * A line's unit cost after its pro-rata share of the discount, to the tiyin.
 * The lines' net values may sum a few tiyin off the payable total; the payable
 * total is what the supplier is owed, so that is the figure kept exact.
 */
export function netUnitPrice(
  docPrice: number,
  gross: number,
  discount: number,
): number {
  if (!(discount > 0) || !(gross > 0)) return docPrice;
  return round2((docPrice * (gross - discount)) / gross);
}
