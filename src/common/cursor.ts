// Keyset ("cursor") pagination for the list endpoints.
//
// `LIMIT n OFFSET m` makes Postgres walk and discard every row before the
// window, so page 200 of a catalogue costs 200x page 1 — and a row inserted
// while the user pages shifts the whole window, which duplicates or hides
// rows. A keyset asks instead for "the rows that sort strictly after this one",
// which is a range scan over the ORDER BY index: the same cost on every page,
// and stable under concurrent inserts.
//
// The contract with the client:
//
//   - `cursor` is opaque. It encodes the sort key of the LAST row of the page
//     the client just saw, in ORDER BY order.
//   - It is a *hint*, never the source of truth: an unreadable one (an old
//     format, a truncated URL) is ignored and the request falls back to its
//     `page`/offset, so a stale bookmark degrades instead of erroring.
//   - Responses carry `nextCursor` — null when the page just served was the
//     last one, so "Next" can be disabled without a count.
//
// Only strictly-descending sorts are supported (every list here is
// newest-first); an ascending list would need the mirrored comparison.

import {AnyColumn, SQL, sql} from 'drizzle-orm';

/** One column of the sort key, listed in the same order as the ORDER BY. */
export interface KeysetKey {
  column: AnyColumn;
  /**
   * The Postgres type the encoded text is cast back to. A cursor travels as
   * text, and `(created_at, id) < ($1, $2)` would otherwise compare a timestamp
   * against an untyped literal — which Postgres resolves inconsistently once
   * more than one column is involved.
   */
  cast: 'timestamp' | 'numeric' | 'text';
  /** Pulls this column's value out of a result row, to encode the next cursor. */
  read: (row: Record<string, unknown>) => Date | string | number | null;
}

/**
 * Postgres wall-time literal for a `timestamp` column. postgres-js refuses a
 * bare `Date` inside a raw `sql` template (the query builder serializes them,
 * raw fragments do not), so the value is bound as a string — see the same fix
 * in report.service.ts.
 */
function pgLiteral(value: Date | string | number | null): string {
  if (value === null) return '';
  if (value instanceof Date) {
    return value.toISOString().slice(0, 23).replace('T', ' ');
  }
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) {
    // An ISO string that came back from a driver that stringifies timestamps.
    return value.slice(0, 23).replace('T', ' ');
  }
  return String(value);
}

/**
 * The select field that carries the sort key's timestamp as Postgres text.
 *
 * A timestamp read the normal way becomes a JS Date, which keeps milliseconds;
 * the columns keep microseconds (`defaultNow()`), and every row one statement
 * or transaction writes shares a single `now()` — a sale's ledger rows, a bulk
 * import. A cursor cut to the millisecond sorts before all of those tied rows,
 * so a page that ended inside such a batch skipped the rest of it. Selecting
 * `cursorAtField(keys)` alongside the row gives encodeCursor the exact value;
 * takePage strips it again, so it never reaches a response.
 */
export function cursorAtField(keys: readonly KeysetKey[]): {
  cursorAt: SQL<string>;
} {
  const stamps = keys.filter((key) => key.cast === 'timestamp');
  if (stamps.length !== 1) {
    throw new Error('cursorAtField: a keyset needs exactly one timestamp key');
  }
  return {cursorAt: sql<string>`${stamps[0].column}::text`};
}

/** Encodes the sort key of a row into the opaque `cursor` string. */
export function encodeCursor(
  row: Record<string, unknown>,
  keys: readonly KeysetKey[],
): string {
  // The exact text from cursorAtField when the row carries it; key.read is the
  // millisecond fallback for a select that does not.
  const exact = typeof row.cursorAt === 'string' ? row.cursorAt : null;
  const parts = keys.map((key) =>
    key.cast === 'timestamp' && exact !== null
      ? exact
      : pgLiteral(key.read(row)),
  );
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/**
 * Reads a cursor back. Returns null for anything that is not a cursor of the
 * expected shape — the caller then serves the offset page instead of failing.
 */
export function decodeCursor(
  raw: string | undefined | null,
  arity: number,
): string[] | null {
  if (!raw) return null;
  try {
    const parts: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (!Array.isArray(parts) || parts.length !== arity) return null;
    if (!parts.every((part) => typeof part === 'string')) return null;
    return parts;
  } catch {
    return null;
  }
}

/**
 * `(a, b, c) < ($1, $2, $3)` — the row-wise comparison that matches a
 * descending `ORDER BY a DESC, b DESC, c DESC`. Written as one row comparison
 * rather than the equivalent OR-chain because only this form is planned as a
 * single index range scan.
 */
export function keysetBefore(
  keys: readonly KeysetKey[],
  values: readonly string[],
): SQL {
  const columns = sql.join(
    keys.map((key) => sql`${key.column}`),
    sql`, `,
  );
  const bounds = sql.join(
    keys.map((key, i) =>
      key.cast === 'text'
        ? sql`${values[i]}`
        : sql`${values[i]}::${sql.raw(key.cast)}`,
    ),
    sql`, `,
  );
  return sql`(${columns}) < (${bounds})`;
}

/** Drops the cursorAtField column from a row, so it never reaches a response. */
function withoutCursorAt<T extends Record<string, unknown>>(
  row: T,
): Omit<T, 'cursorAt'> {
  if (!('cursorAt' in row)) return row;
  const copy: Partial<T> = {...row};
  delete copy.cursorAt;
  return copy as Omit<T, 'cursorAt'>;
}

/**
 * Splits an over-fetched result (`limit + 1` rows) into the page itself and the
 * cursor that opens the next one. Over-fetching by one is how "is there a next
 * page?" is answered without a second query or a count. The returned rows have
 * the cursorAtField column stripped.
 */
export function takePage<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  keys: readonly KeysetKey[],
): {rows: Omit<T, 'cursorAt'>[]; nextCursor: string | null} {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page.map(withoutCursorAt),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1], keys) : null,
  };
}

/**
 * The sort key nearly every list here uses: newest-first with the row id as the
 * tiebreaker. The id is not decoration — a bulk import writes thousands of rows
 * inside the same millisecond, and `created_at` alone leaves their order to the
 * planner, which is exactly where a keyset would skip or repeat rows. Select
 * `cursorAtField(keys)` with the rows too, or the tie is lost to milliseconds.
 */
export function createdAtKeys(
  createdAt: AnyColumn,
  id: AnyColumn,
): KeysetKey[] {
  return [
    {
      column: createdAt,
      cast: 'timestamp',
      read: (row) => (row.createdAt ?? null) as Date | string | null,
    },
    {
      column: id,
      cast: 'text',
      read: (row) => (row.id ?? null) as string | null,
    },
  ];
}
