import {sql} from 'drizzle-orm';
import {PgDialect, QueryBuilder} from 'drizzle-orm/pg-core';
import {businesses} from '../database/schema';
import {
  requiredFactColumns,
  requiredFactsFromRow,
  STEP_EXISTS,
  stepExists,
  storeFact,
} from './onboarding.conditions';

const dialect = new PgDialect();
const render = (q: ReturnType<typeof sql>) => dialect.sqlToQuery(q);

describe('stepExists', () => {
  it('gives a kitchen its own product condition and everyone else the shared one', () => {
    expect(stepExists('product', 'food')).not.toBe(STEP_EXISTS.product);
    expect(stepExists('product', 'retail')).toBe(STEP_EXISTS.product);
    expect(stepExists('product', 'online')).toBe(STEP_EXISTS.product);
    expect(stepExists('sale', 'food')).toBe(STEP_EXISTS.sale);
    expect(render(stepExists('product', 'food')(sql`${'b1'}`)).sql).toContain("p.kind = 'dish'");
  });

  it('binds the single-shop id as a parameter', () => {
    const q = render(stepExists('sale', 'retail')(sql`${'b1'}`));
    expect(q.params).toEqual(['b1']);
    expect(q.sql).toContain('o.business_id = $1');
  });
});

describe('requiredFactColumns', () => {
  it('correlates every probe on "businesses"."id", never a bare "id"', () => {
    const q = new QueryBuilder()
      .select({id: businesses.id, ...requiredFactColumns()})
      .from(businesses)
      .toSQL();
    expect(q.params).toEqual([]);
    expect(q.sql).toContain('p.business_id = "businesses"."id"');
    expect(q.sql).toContain('o.business_id = "businesses"."id"');
    expect(q.sql).not.toMatch(/business_id = "id"/);
    // Kitchen product condition is the food branch of the product column.
    expect(q.sql).toMatch(/CASE WHEN "businesses"."business_type" = 'food'\s+THEN EXISTS[\s\S]*p\.kind = 'dish'/);
  });
});

describe('requiredFactsFromRow / storeFact', () => {
  it('reads only true as done and needs both store flags', () => {
    expect(
      requiredFactsFromRow({product: true, stock: 't', sale: null, storeEnabled: true, storeSlug: 'x'}),
    ).toEqual({product: true, stock: false, store: true, sale: false});
    expect(storeFact({storeEnabled: true, storeSlug: null})).toBe(false);
    expect(storeFact({storeEnabled: true, storeSlug: ''})).toBe(false);
    expect(storeFact({storeEnabled: false, storeSlug: 'x'})).toBe(false);
  });
});
