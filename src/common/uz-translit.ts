/**
 * Latin → Cyrillic transliteration for classifier search.
 *
 * Every one of the 382 873 rows in `mxik_classifier` is Cyrillic — the
 * tasnif.soliq.uz export has no Latin at all — while our UI, and every product
 * name our shops actually type, is Latin. So a shopkeeper searching "non" or
 * "sut" matches nothing unless we transliterate the query first.
 *
 * The mapping is deliberately lossy-tolerant: it is only ever used to widen a
 * search (callers OR it with the raw query), never to rewrite stored data, so
 * an imperfect guess costs recall at worst, never correctness. Digraphs are
 * replaced before single letters, longest first, or "sh" would become "сҳ".
 */

// Order matters: longest sequences first.
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["o'", 'ў'],
  ['oʻ', 'ў'],
  ["g'", 'ғ'],
  ['gʻ', 'ғ'],
  ['sh', 'ш'],
  ['ch', 'ч'],
  ['ya', 'я'],
  ['yo', 'ё'],
  ['yu', 'ю'],
  ['ts', 'ц'],
  ['a', 'а'],
  ['b', 'б'],
  ['d', 'д'],
  ['e', 'е'],
  ['f', 'ф'],
  ['g', 'г'],
  ['h', 'ҳ'],
  ['i', 'и'],
  ['j', 'ж'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['q', 'қ'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['v', 'в'],
  ['x', 'х'],
  ['y', 'й'],
  ['z', 'з'],
];

const HAS_CYRILLIC = /[Ѐ-ӿ]/;

/**
 * Returns the Cyrillic form of a Latin query, or null when transliterating
 * would add nothing — the input already contains Cyrillic, or holds no letter
 * this mapping touches (a barcode, say). Callers use null to skip the extra
 * OR branch instead of running the same predicate twice.
 */
export function latinToCyrillic(input: string): string | null {
  const source = input.trim();
  if (!source || HAS_CYRILLIC.test(source)) return null;

  const lower = source.toLowerCase();
  let out = '';
  let i = 0;
  outer: while (i < lower.length) {
    for (const [latin, cyrillic] of PAIRS) {
      if (lower.startsWith(latin, i)) {
        out += cyrillic;
        i += latin.length;
        continue outer;
      }
    }
    // Anything unmapped (digits, spaces, punctuation) passes through as-is.
    out += lower[i];
    i += 1;
  }

  return out === lower ? null : out;
}

/**
 * Escapes POSIX-regex metacharacters so a user-typed query can be embedded in a
 * `~*` pattern. Without it a search for "1.5 l" or "sok (mix)" is either a
 * wrong match or a regex syntax error from Postgres.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
