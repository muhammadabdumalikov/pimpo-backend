/**
 * Matching a transcribed delivery-note row to a product in the shop's own
 * catalogue.
 *
 * Pure and DB-free on purpose: the whole interesting part is the string
 * folding, which is worth unit-testing without a Postgres round trip.
 *
 * Two paths, in order of trust:
 *   1. barcode / SKU — exact, and the only one that can be relied on blindly;
 *   2. name similarity — a SUGGESTION. The owner confirms it on screen, so the
 *      job here is to put the right product first and offer runners-up, not to
 *      be certain.
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
  by: 'barcode' | 'code' | 'name';
  /** 0..1. Always 1 for an exact barcode or SKU hit. */
  score: number;
}

/**
 * Similarity at or above which a name match is offered as THE match rather than
 * just an alternative.
 *
 * Tuned low on purpose. A missed match costs the owner a dropdown click; a
 * wrong one that they wave through writes the wrong product into stock. Both
 * are visible on the confirm screen, so the cheaper mistake is the one to make.
 */
export const NAME_MATCH_THRESHOLD = 0.55;

/** Cyrillic → Latin, longest sequences first. */
const CYRILLIC: ReadonlyArray<readonly [string, string]> = [
  ['щ', 'sh'],
  ['ш', 'sh'],
  ['ч', 'ch'],
  ['ц', 'ts'],
  ['я', 'ya'],
  ['ю', 'yu'],
  ['ё', 'yo'],
  ['ж', 'j'],
  ['ъ', ''],
  ['ь', ''],
  ['ы', 'i'],
  ['э', 'e'],
  ['й', 'y'],
  ['ў', 'o'],
  ['ғ', 'g'],
  ['қ', 'q'],
  ['ҳ', 'h'],
  ['х', 'x'],
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'v'],
  ['г', 'g'],
  ['д', 'd'],
  ['е', 'e'],
  ['з', 'z'],
  ['и', 'i'],
  ['к', 'k'],
  ['л', 'l'],
  ['м', 'm'],
  ['н', 'n'],
  ['о', 'o'],
  ['п', 'p'],
  ['р', 'r'],
  ['с', 's'],
  ['т', 't'],
  ['у', 'u'],
  ['ф', 'f'],
];

const CYRILLIC_RE = new RegExp(
  `(${CYRILLIC.map(([c]) => c).join('|')})`,
  'g',
);
const CYRILLIC_MAP = new Map(CYRILLIC);

/**
 * Folds a product name to a single comparable form: lowercase Latin letters
 * and digits, nothing else.
 *
 * The two sides of a comparison rarely share a script: a shop's catalogue is
 * Latin while half the delivery notes in the country are printed in Cyrillic,
 * so "Кока-кола 1л" and "Coca Cola 1 l" have to land on the same string. Both
 * are folded to Latin, then `c` is rewritten to `k` (outside the `ch` digraph,
 * which is a real Uzbek sound) so the Latin spelling of a borrowed word meets
 * the Cyrillic one: coca → koka, кока → koka.
 *
 * Deliberately lossy. It only ever widens a suggestion the owner confirms.
 */
export function foldForMatch(input: string): string {
  let out = input.toLowerCase();

  out = out.replace(CYRILLIC_RE, (ch) => CYRILLIC_MAP.get(ch) ?? ch);

  // Uzbek Latin writes ў/ғ with a following mark; drop it so o'/oʻ/o all fold
  // together (the Cyrillic branch above already produced the bare letter).
  out = out.replace(/[ʻʼ'`’]/g, '');

  // `ch` is a letter in Uzbek, `c` alone is not — park the digraph, collapse
  // the stray c's onto k, put the digraph back.
  out = out.replace(/ch/g, '\u0001').replace(/c/g, 'k').replace(/\u0001/g, 'ch');
  out = out.replace(/w/g, 'v');

  // Every separator is dropped rather than normalised to a space, because on a
  // delivery note the gaps are noise: "1л", "1 л", "1L" and "Coca-Cola,1L" are
  // the same product written four ways, and a space is the difference between
  // matching and not. Bigrams over the squashed string still tolerate reordered
  // words, so nothing is lost by giving up the word boundaries.
  return out.replace(/[^a-z0-9]+/g, '');
}

/** Character bigrams of a folded string, for the Dice coefficient below. */
function bigrams(folded: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < folded.length - 1; i++) {
    set.add(folded.slice(i, i + 2));
  }
  return set;
}

/**
 * Sørensen–Dice similarity over character bigrams, 0..1.
 *
 * Chosen over edit distance because delivery notes reorder and drop words far
 * more often than they misspell them: "Sut 1l Nestle" vs "Nestle sut 1 l" is a
 * near-miss for Dice and a catastrophe for Levenshtein.
 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  // Iterate the smaller set: the work is then bounded by the shorter name.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) if (large.has(gram)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Digits only, so `4780015` and `4-780015` are the same barcode. */
function foldCode(input: string | null | undefined): string {
  return (input ?? '').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}

/**
 * The shop's catalogue, pre-folded once so a 60-line invoice does not re-fold
 * every product name 60 times.
 */
export class CatalogIndex {
  /** Barcode/SKU → product. First writer wins; duplicates are a data problem. */
  private readonly byCode = new Map<
    string,
    {entry: CatalogEntry; by: 'barcode' | 'code'}
  >();
  private readonly folded: {entry: CatalogEntry; grams: Set<string>}[] = [];

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
      this.folded.push({entry, grams: bigrams(foldForMatch(entry.name))});
    }
  }

  get size(): number {
    return this.folded.length;
  }

  /**
   * Best candidates for one invoice row, best first.
   *
   * A barcode hit short-circuits: it is exact, and offering name-based
   * runners-up next to it would only invite a wrong click.
   */
  find(
    name: string,
    barcode: string | null,
    limit = 5,
  ): MatchCandidate[] {
    const code = foldCode(barcode);
    const exact = code ? this.byCode.get(code) : undefined;
    if (exact) {
      return [toCandidate(exact.entry, exact.by, 1)];
    }

    const grams = bigrams(foldForMatch(name));
    if (!grams.size) return [];

    const scored: MatchCandidate[] = [];
    for (const {entry, grams: other} of this.folded) {
      const score = similarity(grams, other);
      // Below a tenth the two names share almost nothing; keeping them would
      // only pad the alternatives list with noise.
      if (score >= 0.1) scored.push(toCandidate(entry, 'name', score));
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

function toCandidate(
  entry: CatalogEntry,
  by: MatchCandidate['by'],
  score: number,
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
    score: Math.round(score * 100) / 100,
  };
}
