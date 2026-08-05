import {SqlRejection, validateSelect} from './sql-validator';

/**
 * These are the assertions that matter most in the whole AI feature.
 *
 * The validator is not the security boundary — the read-only role, the RLS
 * policies, the read-only transaction and the extended wire protocol are. But
 * it is the layer that is cheap to test exhaustively, and a regression here is
 * an early warning that someone has loosened the reasoning behind the rest.
 */

function expectRejected(sql: string, code?: string) {
  let thrown: unknown;
  try {
    validateSelect(sql);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SqlRejection);
  if (code) expect((thrown as SqlRejection).code).toBe(code);
}

describe('validateSelect', () => {
  describe('accepts legitimate analytics', () => {
    it('a plain aggregate', () => {
      expect(() =>
        validateSelect(
          "SELECT count(*) AS orders FROM orders WHERE status = 'Completed'",
        ),
      ).not.toThrow();
    });

    it('a join with the composite-key category rule', () => {
      expect(() =>
        validateSelect(`
          SELECT c.name AS category, SUM(oi.line_total) AS revenue
            FROM order_items oi
            JOIN products p ON p.id = oi.product_id
            JOIN categories c
              ON p.category_id = c.id AND p.business_id = c.business_id
           GROUP BY c.name
           ORDER BY revenue DESC
           LIMIT 10`),
      ).not.toThrow();
    });

    it('the business-day shift and a numeric cast', () => {
      expect(() =>
        validateSelect(`
          SELECT date_trunc('day', o.created_at + interval '5 hours') AS day,
                 ROUND(SUM(oi.quantity)::numeric, 2) AS units
            FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
           GROUP BY 1`),
      ).not.toThrow();
    });

    it('a CTE whose alias is not a real table', () => {
      expect(() =>
        validateSelect(`
          WITH daily AS (
            SELECT created_at::date AS d, total_amount FROM orders
          )
          SELECT d, SUM(total_amount) AS revenue FROM daily GROUP BY d`),
      ).not.toThrow();
    });

    it('a LATERAL jsonb expansion of the payments column', () => {
      // This exact shape already exists in report.service.ts, and is the reason
      // node-sql-parser was rejected in favour of pgsql-ast-parser.
      expect(() =>
        validateSelect(`
          SELECT elem->>'method' AS method, SUM((elem->>'amount')::numeric) AS total
            FROM orders o,
                 LATERAL jsonb_array_elements(COALESCE(o.payments, '[]'::jsonb)) AS elem
           GROUP BY 1`),
      ).not.toThrow();
    });

    it('a window function', () => {
      expect(() =>
        validateSelect(`
          SELECT name, total_spent,
                 row_number() OVER (ORDER BY total_spent DESC) AS rank
            FROM users`),
      ).not.toThrow();
    });

    it('tolerates a single trailing semicolon', () => {
      expect(() => validateSelect('SELECT 1 AS x FROM orders;')).not.toThrow();
    });
  });

  describe('statement shape', () => {
    it('rejects chained statements', () => {
      expectRejected(
        'SELECT 1 FROM orders; DROP TABLE orders',
        'MULTI_STATEMENT',
      );
    });

    it.each([
      ["INSERT INTO orders (id) VALUES ('x')"],
      ['UPDATE products SET price_out = 0'],
      ['DELETE FROM orders'],
      ['CREATE TABLE evil (id int)'],
      ['DROP TABLE orders'],
      ['ALTER TABLE orders ADD COLUMN x int'],
      ['TRUNCATE TABLE orders'],
    ])('rejects %s', (sql) => {
      expectRejected(sql);
    });

    it('rejects an empty query', () => {
      expectRejected('   ', 'EMPTY');
    });
  });

  describe('lexical smuggling', () => {
    it.each([
      ['SELECT 1 FROM orders -- comment'],
      ['SELECT /* hidden */ 1 FROM orders'],
      ['SELECT $$payload$$ FROM orders'],
    ])('rejects %s', (sql) => {
      expectRejected(sql, 'FORBIDDEN_TOKEN');
    });
  });

  describe('privileged surfaces', () => {
    it.each([
      ["SELECT pg_read_file('/etc/passwd') FROM orders"],
      ['SELECT pg_sleep(30) FROM orders'],
      ['SELECT * FROM pg_class'],
      ['SELECT * FROM information_schema.columns'],
      ["SELECT dblink('', '') FROM orders"],
      ["SELECT current_setting('app.business_id') FROM orders"],
      ['SET ROLE postgres'],
      ["COPY (SELECT 1) TO PROGRAM 'sh'"],
    ])('rejects %s', (sql) => {
      expectRejected(sql);
    });
  });

  describe('table allowlist', () => {
    it.each([
      ['SELECT * FROM store_bots'],
      ['SELECT * FROM billz_migration_state'],
      ['SELECT * FROM businesses'],
      ['SELECT * FROM roles'],
      ['SELECT * FROM telegram_links'],
    ])('rejects %s', (sql) => {
      expectRejected(sql, 'TABLE_NOT_ALLOWED');
    });

    it('rejects a denied table reached through a join', () => {
      expectRejected(
        'SELECT b.password FROM orders o JOIN businesses b ON b.id = o.business_id',
        'TABLE_NOT_ALLOWED',
      );
    });

    it('rejects a denied table inside a subquery', () => {
      expectRejected(
        'SELECT (SELECT bot_token FROM store_bots LIMIT 1) AS x FROM orders',
        'TABLE_NOT_ALLOWED',
      );
    });
  });

  describe('function allowlist', () => {
    it('rejects a function outside the allowlist', () => {
      expectRejected(
        "SELECT query_to_xml('select 1', true, true, '') FROM orders",
        'FUNCTION_NOT_ALLOWED',
      );
    });
  });

  describe('size', () => {
    it('rejects an oversized query', () => {
      const padding = 'a'.repeat(9_000);
      expectRejected(`SELECT '${padding}' AS x FROM orders`, 'TOO_LONG');
    });
  });
});
