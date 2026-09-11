// Pure money math for a customer return ("qaytarish") — no DB, unit-tested in
// return-math.spec.ts. The service gathers the order's current state (what was
// sold, what came back before, the open debt, the loyalty ledger) and this
// decides what the new return is worth and how it is settled.
//
// Rules:
//  - A returned line is valued at its own sale price (lineTotal pro-rata by
//    quantity) less its share of the order-level discount (total/subtotal).
//  - Finishing a line or the whole order uses the exact remainder, so a sale
//    returned in several goes always nets back to the cent.
//  - Settlement is a waterfall: the unpaid debt of a credit sale shrinks
//    first, then loyalty points spent on the sale come back, and only the rest
//    is refunded as money. Cashback earned on the sale is taken back pro rata.

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 1e-6;

export interface ReturnLineInput {
  orderItemId: string;
  soldQty: number;
  lineTotal: number;
  costTotal: number;
  /** Totals already returned for this line by earlier returns. */
  returnedQty: number;
  returnedGross: number;
  returnedCost: number;
  /** Weighed goods: a returned line counts as one item, like on the sale. */
  isKg: boolean;
  /** Quantity coming back now (0 = not part of this return). */
  requestQty: number;
  restock: boolean;
}

export interface ReturnInput {
  orderSubtotal: number;
  orderTotal: number;
  /** Net value already returned against the order (orders.returned_amount). */
  orderReturnedAmount: number;
  lines: ReturnLineInput[];
  /** Unpaid remainder of the sale's debt right now (0 for a paid sale). */
  debtRemaining: number;
  /** Loyalty points spent on the sale, and how many earlier returns gave back. */
  pointsRedeemed: number;
  pointsRestoredSoFar: number;
  /** Cashback earned on the sale, and how much earlier returns took back. */
  pointsEarned: number;
  pointsReversedSoFar: number;
}

export interface ReturnLineResult {
  orderItemId: string;
  quantity: number;
  lineTotal: number;
  netAmount: number;
  costTotal: number;
  restock: boolean;
}

export interface ReturnResult {
  lines: ReturnLineResult[];
  itemCount: number;
  grossAmount: number;
  discountAmount: number;
  totalAmount: number;
  debtReduced: number;
  pointsRestored: number;
  pointsReversed: number;
  refundAmount: number;
  costTotal: number;
  restockedCost: number;
  /** True when this return brings back everything still on the receipt. */
  isFinal: boolean;
}

export function computeReturn(input: ReturnInput): ReturnResult {
  const ratio =
    input.orderSubtotal > 0 ? input.orderTotal / input.orderSubtotal : 1;

  const isFinal = input.lines.every(
    (l) => l.returnedQty + l.requestQty >= l.soldQty - EPS,
  );

  const lines: ReturnLineResult[] = [];
  let itemCount = 0;
  for (const l of input.lines) {
    if (l.requestQty <= 0) continue;
    const finishesLine = l.returnedQty + l.requestQty >= l.soldQty - EPS;
    const share = l.soldQty > 0 ? l.requestQty / l.soldQty : 0;
    const gross = finishesLine
      ? round2(l.lineTotal - l.returnedGross)
      : round2(l.lineTotal * share);
    const cost = finishesLine
      ? round2(l.costTotal - l.returnedCost)
      : round2(l.costTotal * share);
    lines.push({
      orderItemId: l.orderItemId,
      quantity: l.requestQty,
      lineTotal: gross,
      netAmount: round2(gross * ratio),
      costTotal: cost,
      restock: l.restock,
    });
    itemCount += l.isKg ? 1 : Math.round(l.requestQty);
  }

  const grossAmount = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  let totalAmount = round2(lines.reduce((s, l) => s + l.netAmount, 0));

  // The last return of a receipt takes exactly what is left of the order total,
  // absorbing the per-line rounding into its last line.
  if (isFinal && lines.length > 0) {
    const remainder = round2(input.orderTotal - input.orderReturnedAmount);
    const drift = round2(remainder - totalAmount);
    if (drift !== 0) {
      const last = lines[lines.length - 1];
      last.netAmount = round2(last.netAmount + drift);
      totalAmount = remainder;
    }
  }
  totalAmount = Math.max(0, totalAmount);

  const debtReduced = round2(
    Math.min(totalAmount, Math.max(0, input.debtRemaining)),
  );
  const pointsLeft = Math.max(
    0,
    input.pointsRedeemed - input.pointsRestoredSoFar,
  );
  const pointsRestored = round2(
    Math.min(totalAmount - debtReduced, pointsLeft),
  );
  const refundAmount = round2(
    Math.max(0, totalAmount - debtReduced - pointsRestored),
  );

  const earnedLeft = Math.max(0, input.pointsEarned - input.pointsReversedSoFar);
  const pointsReversed = isFinal
    ? earnedLeft
    : Math.min(
        earnedLeft,
        input.orderTotal > 0
          ? Math.round((input.pointsEarned * totalAmount) / input.orderTotal)
          : 0,
      );

  const costTotal = round2(lines.reduce((s, l) => s + l.costTotal, 0));
  const restockedCost = round2(
    lines.filter((l) => l.restock).reduce((s, l) => s + l.costTotal, 0),
  );

  return {
    lines,
    itemCount,
    grossAmount,
    discountAmount: round2(grossAmount - totalAmount),
    totalAmount,
    debtReduced,
    pointsRestored,
    pointsReversed,
    refundAmount,
    costTotal,
    restockedCost,
    isFinal,
  };
}
