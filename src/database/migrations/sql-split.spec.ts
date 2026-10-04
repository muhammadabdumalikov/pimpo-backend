import * as fs from 'fs';
import * as path from 'path';
import {needsNoTransaction, splitSqlStatements} from './sql-split';

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(
      splitSqlStatements(`CREATE TABLE a (x int);
INSERT INTO a VALUES (1);`),
    ).toEqual(['CREATE TABLE a (x int)', 'INSERT INTO a VALUES (1)']);
  });

  it('keeps a DO block whole', () => {
    const doBlock = `DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['a','b'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO r', t);
  END LOOP;
END $$`;
    expect(splitSqlStatements(`${doBlock};\nSELECT 1;`)).toEqual([
      doBlock,
      'SELECT 1',
    ]);
  });

  it('honours named dollar tags, strings and quoted identifiers', () => {
    expect(
      splitSqlStatements(
        `CREATE FUNCTION f() RETURNS text AS $fn$ SELECT 'a;b' $fn$ LANGUAGE sql;` +
          `SELECT 'it''s; fine', "odd;name" FROM t;` +
          `SELECT E'esc\\'; still' ;`,
      ),
    ).toEqual([
      `CREATE FUNCTION f() RETURNS text AS $fn$ SELECT 'a;b' $fn$ LANGUAGE sql`,
      `SELECT 'it''s; fine', "odd;name" FROM t`,
      `SELECT E'esc\\'; still'`,
    ]);
  });

  it('ignores semicolons in comments and drops comment-only statements', () => {
    expect(
      splitSqlStatements(`-- header; with a semicolon
/* block; /* nested; */ still comment */
SELECT 1; -- trailing; comment
--> statement-breakpoint
`),
    ).toEqual([
      `-- header; with a semicolon
/* block; /* nested; */ still comment */
SELECT 1`,
    ]);
  });

  it('keeps a final statement without a semicolon', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2')).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('does not mistake a parameter for a dollar quote', () => {
    expect(splitSqlStatements('SELECT $1; SELECT 2;')).toEqual([
      'SELECT $1',
      'SELECT 2',
    ]);
  });
});

describe('needsNoTransaction', () => {
  it('spots CONCURRENTLY in SQL but not in prose', () => {
    expect(
      needsNoTransaction('CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (x);'),
    ).toBe(true);
    expect(
      needsNoTransaction(
        '-- built CONCURRENTLY elsewhere\nCREATE INDEX i ON t (x);',
      ),
    ).toBe(false);
    expect(needsNoTransaction(`SELECT 'concurrently';`)).toBe(true); // literal counts: errs safe
  });

  it('honours the explicit marker', () => {
    expect(needsNoTransaction('-- migrate:no-transaction\nVACUUM t;')).toBe(
      true,
    );
  });
});

// The real migrations: every file must split into statements that rejoin to
// the same SQL (nothing lost), and the CONCURRENTLY files must be the ones
// running outside a transaction.
describe('drizzle/*.sql', () => {
  const dir = path.resolve(__dirname, '../../../drizzle');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f));

  it('finds the migrations', () => {
    expect(files.length).toBeGreaterThan(90);
  });

  it('runs exactly the CONCURRENTLY files statement by statement', () => {
    const noTx = files.filter((f) =>
      needsNoTransaction(fs.readFileSync(path.join(dir, f), 'utf8')),
    );
    expect(noTx).toEqual([
      '0064_product_mxik.sql',
      '0066_scale_plu.sql',
      '0075_pagination_indexes.sql',
      '0076_product_barcode_unique.sql',
      '0077_order_items_product_idx.sql',
      '0084_order_items_weight_source.sql',
      '0091_schema_parity.sql',
    ]);
  });

  it('loses no SQL when splitting', () => {
    const squash = (s: string) =>
      s
        .replace(/--[^\n]*/g, '')
        .replace(/;/g, '')
        .replace(/\s+/g, '');
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect([f, squash(splitSqlStatements(text).join('\n'))]).toEqual([
        f,
        squash(text),
      ]);
    }
  });
});
