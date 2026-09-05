import {CatalogEntry, CatalogIndex} from './invoice-match';

function product(
  id: string,
  name: string,
  extra: Partial<CatalogEntry> = {},
): CatalogEntry {
  return {
    id,
    name,
    barcode: null,
    code: null,
    quantityType: 'piece',
    priceIn: 1000,
    priceOut: 1500,
    ...extra,
  };
}

describe('CatalogIndex', () => {
  const catalog: CatalogEntry[] = [
    product('p1', 'Coca Cola 1 L', {barcode: '5449000000996'}),
    product('p2', 'Pepsi 1 L', {barcode: '5449000000997'}),
    product('p3', 'Sut Nestle 1 l', {code: 'SUT-001'}),
  ];
  const index = new CatalogIndex(catalog);

  it('matches on barcode exactly', () => {
    expect(index.find('5449000000996')).toMatchObject({
      productId: 'p1',
      by: 'barcode',
      score: 1,
    });
  });

  it('ignores separators inside a barcode', () => {
    expect(index.find('5449-0000-00996')?.productId).toBe('p1');
  });

  it('matches on an internal SKU, case-insensitively', () => {
    expect(index.find('sut-001')).toMatchObject({productId: 'p3', by: 'code'});
  });

  it('returns nothing for a code the catalogue does not carry', () => {
    expect(index.find('0000000000000')).toBeNull();
  });

  it('returns nothing when the row printed no code', () => {
    expect(index.find(null)).toBeNull();
    expect(index.find('')).toBeNull();
  });

  it('returns nothing for a code with no alphanumerics at all', () => {
    expect(index.find('---')).toBeNull();
  });

  // The point of taking name matching out: a name, however close, is never a
  // match. An unmatched row is the honest answer and the owner picks.
  it('never matches on a name, however exact', () => {
    expect(index.find('Coca Cola 1 L')).toBeNull();
  });

  it('prefers the first product when two share a barcode', () => {
    const dupes = new CatalogIndex([
      product('a', 'A', {barcode: '111'}),
      product('b', 'B', {barcode: '111'}),
    ]);
    expect(dupes.find('111')?.productId).toBe('a');
  });

  it('counts every entry, including those with no code', () => {
    expect(index.size).toBe(3);
  });
});
