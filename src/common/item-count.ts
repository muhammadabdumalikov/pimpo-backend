/**
 * What one line adds to a document's `item_count` — an integer column on
 * orders, receipts, returns and write-offs.
 *
 * Weighed goods count as one item: their kg is not a piece count. So does any
 * fractional quantity, whatever the card says: a product whose unit is not
 * marked weighed can still arrive or leave as 2.5 (kolbasa received by the
 * kilo on a "piece" card), and 2.5 in an integer column fails the whole
 * document with a bare 500.
 */
export function itemCountOf(
  qty: number,
  quantityType: string | null | undefined,
): number {
  return quantityType === 'kg' || !Number.isInteger(qty) ? 1 : qty;
}
