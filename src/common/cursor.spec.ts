import {PgDialect} from 'drizzle-orm/pg-core';

import {products} from '../database/schema';
import {
  createdAtKeys,
  decodeCursor,
  encodeCursor,
  keysetBefore,
  takePage,
} from './cursor';

const KEYS = createdAtKeys(products.createdAt, products.id);

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a row into Postgres wall-time text', () => {
    const cursor = encodeCursor(
      {createdAt: new Date('2026-09-14T08:30:00.123Z'), id: 'p-1'},
      KEYS,
    );
    expect(decodeCursor(cursor, 2)).toEqual(['2026-09-14 08:30:00.123', 'p-1']);
  });

  it('normalizes a driver-stringified timestamp the same way', () => {
    const cursor = encodeCursor(
      {createdAt: '2026-09-14T08:30:00.123Z', id: 'p-1'},
      KEYS,
    );
    expect(decodeCursor(cursor, 2)).toEqual(['2026-09-14 08:30:00.123', 'p-1']);
  });

  it('rejects anything that is not a cursor of the expected shape', () => {
    expect(decodeCursor(undefined, 2)).toBeNull();
    expect(decodeCursor('', 2)).toBeNull();
    expect(decodeCursor('not-base64!!', 2)).toBeNull();
    // Valid base64url, but not our payload.
    expect(decodeCursor(Buffer.from('{}').toString('base64url'), 2)).toBeNull();
    // Right format, wrong arity — a cursor from a differently sorted list.
    expect(
      decodeCursor(encodeCursor({createdAt: new Date(), id: 'x'}, KEYS), 3),
    ).toBeNull();
  });
});

describe('keysetBefore', () => {
  it('compares the sort key row-wise, casting the bound values', () => {
    const {sql: text, params} = new PgDialect().sqlToQuery(
      keysetBefore(KEYS, ['2026-09-14 08:30:00.123', 'p-1']),
    );
    // One row comparison (not an OR-chain) so Postgres plans a single index
    // range scan, with the values bound rather than inlined.
    expect(text).toBe(
      '("products"."created_at", "products"."id") < ($1::timestamp, $2)',
    );
    expect(params).toEqual(['2026-09-14 08:30:00.123', 'p-1']);
  });
});

describe('takePage', () => {
  const rows = [
    {createdAt: new Date('2026-09-14T10:00:00Z'), id: 'a'},
    {createdAt: new Date('2026-09-14T09:00:00Z'), id: 'b'},
    {createdAt: new Date('2026-09-14T08:00:00Z'), id: 'c'},
  ];

  it('has no next cursor when the over-fetch came back short', () => {
    expect(takePage(rows, 3, KEYS)).toEqual({rows, nextCursor: null});
    expect(takePage(rows.slice(0, 2), 3, KEYS).nextCursor).toBeNull();
  });

  it('trims the extra row and opens the next page on the last kept one', () => {
    const page = takePage(rows, 2, KEYS);
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(decodeCursor(page.nextCursor, 2)).toEqual([
      '2026-09-14 09:00:00.000',
      'b',
    ]);
  });
});
