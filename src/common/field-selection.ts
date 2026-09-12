// Sparse fieldsets for list endpoints: `GET /products?fields=name,priceOut`.
//
// A list screen lets the user pick which columns it shows ("kerakli ustunlar"),
// and asks the server for just the fields those columns read. The contract:
//
//   - No `fields` param (or an empty one) → the full row, exactly as before.
//     Checkout, exports and the mobile app never send it and must not change.
//   - Unknown names are ignored, not rejected. A column list is cached in the
//     browser, so a client that remembers a field the server has since dropped
//     must still get a page back.
//   - `always` fields (the row id at minimum) are returned regardless: the
//     screen keys rows and opens them by id even when no column shows it.
//
// The narrowed rows are typed as the full row for the caller's convenience;
// at runtime they carry only the requested keys.

/** Splits `a,b,c` (or a repeated `?fields=a&fields=b`) into a set of names. */
export function parseFields(raw: unknown): Set<string> | undefined {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const names = parts
    .flatMap((part) => (typeof part === 'string' ? part.split(',') : []))
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : undefined;
}

/**
 * Narrows a drizzle selection object to the requested keys, so the database
 * only reads those columns. Returns `selection` untouched when nothing was
 * requested.
 */
export function selectFields<T extends Record<string, unknown>>(
  selection: T,
  fields: Set<string> | undefined,
  always: readonly string[] = ['id'],
): T {
  if (!fields) return selection;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(selection)) {
    if (fields.has(key) || always.includes(key)) out[key] = selection[key];
  }
  return out as T;
}

/**
 * The same narrowing for rows assembled in code (relational queries, computed
 * values, joined names), where the select itself can't be trimmed.
 */
export function pickRowFields<T extends object>(
  rows: T[],
  fields: Set<string> | undefined,
  always: readonly string[] = ['id'],
): T[] {
  if (!fields) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (fields.has(key) || always.includes(key)) out[key] = value;
    }
    return out as T;
  });
}
