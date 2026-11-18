// The storefront's "old price" (products.old_price, 0115): the price before a
// markdown, shown struck through next to the selling price.

/** Accepts a plain amount with up to two decimals, or blank to clear it. */
export const OLD_PRICE_PATTERN = /^\s*(\d{1,8}(\.\d{1,2})?)?\s*$/;

/** The old price as stored: a positive amount, or null when blank / zero. */
export function normalizeOldPrice(
  raw: string | number | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(String(raw).trim() || 0);
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : null;
}

/**
 * What the shopper sees: the old price only while it is above the selling
 * price. A later price rise past it (or a typo below it) never shows a fake
 * discount; the owner's value stays stored either way.
 */
export function visibleOldPrice(
  oldPrice: string | null | undefined,
  priceOut: string | number,
): string | null {
  if (oldPrice == null) return null;
  return Number(oldPrice) > Number(priceOut) ? oldPrice : null;
}
