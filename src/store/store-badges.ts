// Storefront badges, worked out by the server — the owner sets nothing.
//
// "Yangi" (new): the card was created in the last NEW_DAYS days. A shop that
// has only just filled its catalogue would wear it on every card, which says
// nothing, so it is shown only while the new cards are at most half of the
// catalogue.
//
// "Ommabop" (popular): among the shop's most ordered products over the last
// POPULAR_DAYS days, counted in orders (not quantity, so kilograms and pieces
// compare fairly), with at least POPULAR_MIN_ORDERS orders each. At most one
// card in five wears it, and never more than POPULAR_MAX, so it stays a
// signal rather than wallpaper.

export const storeBadgeRules = {
  newDays: 14,
  popularDays: 30,
  popularMinOrders: 3,
  popularMax: 8,
  cacheMs: 10 * 60_000,
} as const;

export type StoreBadgeContext = {
  /** Product ids that wear "Ommabop". */
  popular: Set<string>;
  /** Whether "Yangi" is shown at all in this shop right now. */
  newOn: boolean;
};

/** How many cards may wear "Ommabop" in a catalogue of `total` products. */
export function popularSlots(total: number): number {
  return Math.min(storeBadgeRules.popularMax, Math.floor(total / 5));
}

/** "Yangi" is shown while recent cards are at most half the catalogue. */
export function newBadgesOn(total: number, recent: number): boolean {
  return recent > 0 && recent * 2 <= total;
}
