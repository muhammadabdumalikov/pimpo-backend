/**
 * Matching a transcribed delivery-note row to a product in the shop's own
 * catalogue.
 *
 * Barcode and SKU only, and both exact. Name similarity used to run here as
 * well, offering the closest-looking product as a suggestion; it was taken out
 * deliberately. A fuzzy suggestion that is right most of the time is worse
 * than no suggestion at all on this screen — it is confirmed by someone
 * working down a long list, and the one it gets wrong writes the wrong product
 * into stock and into that product's cost. A code either matches or it does
 * not, and when it does not the owner picks the product themselves.
 *
 * Pure and DB-free on purpose, so it can be tested without a Postgres round
 * trip.
 */

/** A product, trimmed to what matching and the confirm screen actually need. */
export interface CatalogEntry {
  id: string;
  name: string;
  barcode: string | null;
  code: string | null;
  /** 'kg' marks weighed goods, which the receipt form receives fractionally. */
  quantityType: string | null;
  priceIn: number;
  priceOut: number;
}

export interface MatchCandidate {
  productId: string;
  name: string;
  barcode: string | null;
  code: string | null;
  quantityType: string | null;
  /** The product's CURRENT cost, so the screen can flag a price that moved. */
  priceIn: number;
  priceOut: number;
  by: 'barcode' | 'code';
  /** Always 1: the only matches made here are exact ones. */
  score: number;
}

/** Digits and letters only, so `4780015` and `4-780015` are the same barcode. */
function foldCode(input: string | null | undefined): string {
  return (input ?? '').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}

/**
 * The shop's catalogue, indexed by the codes its products carry.
 *
 * Built once per parse rather than queried per row: a 60-line note against a
 * remote Postgres would otherwise be 60 round trips, and the whole index is a
 * map the size of the catalogue.
 */
export class CatalogIndex {
  /** Barcode/SKU → product. First writer wins; duplicates are a data problem. */
  private readonly byCode = new Map<
    string,
    {entry: CatalogEntry; by: 'barcode' | 'code'}
  >();
  private readonly count: number;

  constructor(entries: CatalogEntry[]) {
    for (const entry of entries) {
      const barcode = foldCode(entry.barcode);
      if (barcode && !this.byCode.has(barcode)) {
        this.byCode.set(barcode, {entry, by: 'barcode'});
      }
      const code = foldCode(entry.code);
      if (code && !this.byCode.has(code)) {
        this.byCode.set(code, {entry, by: 'code'});
      }
    }
    this.count = entries.length;
  }

  get size(): number {
    return this.count;
  }

  /**
   * The product this row's printed code identifies, or null.
   *
   * Null is not a failure — most delivery notes print no code at all, and the
   * row simply arrives at the review without a product for the owner to pick
   * one. That is the honest state, and it is visible: an unmatched row cannot
   * be confirmed.
   */
  find(barcode: string | null): MatchCandidate | null {
    const code = foldCode(barcode);
    if (!code) return null;
    const hit = this.byCode.get(code);
    return hit ? toCandidate(hit.entry, hit.by) : null;
  }
}

function toCandidate(
  entry: CatalogEntry,
  by: MatchCandidate['by'],
): MatchCandidate {
  return {
    productId: entry.id,
    name: entry.name,
    barcode: entry.barcode,
    code: entry.code,
    quantityType: entry.quantityType,
    priceIn: entry.priceIn,
    priceOut: entry.priceOut,
    by,
    score: 1,
  };
}
