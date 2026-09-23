// Which proposed selling prices deserve a second look before they reach the
// shelf — pure rules, no DB, unit-tested in price-risk.spec.ts.
//
// Why it exists: receiving a delivery can move the card's selling price, and
// the dialog that settles it used to open with every row pre-accepted. A row
// reading 15 000 → 150 000 and a row reading 15 000 → 15 600 looked the same,
// so the reflex press on the confirm button put both on the shelf. These rules
// are what tells the two apart, so the dangerous one can arrive un-accepted and
// in red while the ordinary one stays quiet.
//
// Deliberately few and deliberately explainable: every flag names a reason the
// owner can check by eye. A rule nobody can restate is a rule that gets ignored
// once it fires on something harmless.
//
// MIRRORED in pimpo-nextjs/src/lib/priceRisk.ts, which colours the same
// differences while they are still being typed on the receipt form. Change one,
// change the other.

/**
 * 'belowCost'  — the shop would lose money on every unit. The one mistake a
 *                machine can be certain about.
 * 'magnitude'  — the figure is a power of ten away from the card: a zero typed
 *                twice or not at all, not a price decision.
 * 'large'      — a real move, but big enough to be worth reading before it is
 *                accepted.
 * 'cardMoved'  — the card was changed AFTER this document was written, away
 *                from the very figure the document still carries. Accepting
 *                would undo that change. Needs history, so it is set by the
 *                caller, never by `priceFlags`.
 */
export type PriceFlag = 'belowCost' | 'magnitude' | 'large' | 'cardMoved';

/** Flags that mean "stop": shown in red, and never pre-accepted. */
export const SEVERE_FLAGS: readonly PriceFlag[] = ['belowCost', 'magnitude'];

/**
 * Half again, or two thirds. Produce and a moving exchange rate put ±50% moves
 * on ordinary deliveries here, so the bar sits above them — a threshold that
 * fires every week teaches the owner to press past it.
 */
const LARGE_RATIO = 1.5;

/** How close to a power of ten a ratio must sit to read as a lost zero. */
const MAGNITUDE_TOLERANCE = 0.05;

/** 15 000 against 150 000, or 150 000 against 15 000, and the 100× pair. */
function isMagnitudeSlip(ratio: number): boolean {
  return [10, 100, 0.1, 0.01].some(
    (p) => Math.abs(ratio - p) <= p * MAGNITUDE_TOLERANCE,
  );
}

export interface PriceRiskInput {
  /** The card's price for this tier; null when the card does not price it. */
  card: number | null;
  /** The figure the document names for the same tier. */
  proposed: number;
  /** Line cost in base UZS; null when the receipt carries no cost for it. */
  cost: number | null;
}

/**
 * Every reason this one tier's figure is worth a look. Empty is the ordinary
 * case — a price the owner meant to change, by an amount that reads as a price.
 *
 * A card with no price for the tier can only be judged against cost: there is
 * no ratio to take, and "new product" is not a risk.
 */
export function priceFlags({card, proposed, cost}: PriceRiskInput): PriceFlag[] {
  const flags: PriceFlag[] = [];
  if (!(proposed > 0)) return flags;
  if (cost != null && cost > 0 && proposed < cost) flags.push('belowCost');
  if (card != null && card > 0) {
    const ratio = proposed / card;
    // A magnitude slip is always also a large move; naming both would put two
    // reasons on one row that only has one thing wrong with it.
    if (isMagnitudeSlip(ratio)) flags.push('magnitude');
    else if (ratio >= LARGE_RATIO || ratio <= 1 / LARGE_RATIO) {
      flags.push('large');
    }
  }
  return flags;
}

/** True when a flag list carries something that should never be pre-accepted. */
export function isSevere(flags: readonly PriceFlag[]): boolean {
  return flags.some((f) => SEVERE_FLAGS.includes(f));
}
