import {CatalogEntry, CatalogIndex, foldForMatch} from './invoice-match';

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

describe('foldForMatch', () => {
  it('folds Cyrillic and Latin spellings of the same product together', () => {
    expect(foldForMatch('Кока-Кола 1л')).toBe(foldForMatch('Coca Cola 1 l'));
  });

  it('folds Uzbek Latin marks away', () => {
    expect(foldForMatch("O'zbek noni")).toBe(foldForMatch('Ozbek noni'));
    expect(foldForMatch('Ўзбек нони')).toBe(foldForMatch('Ozbek noni'));
  });

  it('keeps ch as a digraph rather than collapsing it onto k', () => {
    expect(foldForMatch('Choy')).toBe('choy');
    expect(foldForMatch('Чой')).toBe('choy');
  });

  it('drops the spacing between a number and its unit', () => {
    expect(foldForMatch('Sut 1 l')).toBe('sut1l');
    expect(foldForMatch('Сут 1л')).toBe('sut1l');
  });

  it('treats punctuation as a separator', () => {
    expect(foldForMatch('Sut,1L')).toBe(foldForMatch('Sut 1 l'));
  });

  it('returns an empty string for a name with no letters or digits', () => {
    expect(foldForMatch('---')).toBe('');
  });
});

describe('CatalogIndex', () => {
  const catalog = [
    product('p1', 'Coca Cola 1L', {barcode: '5449000000996'}),
    product('p2', 'Pepsi 1L', {barcode: '5449000011527'}),
    product('p3', 'Sut Nestle 1l', {code: 'SUT-001'}),
    product('p4', 'Non oddiy'),
  ];
  const index = new CatalogIndex(catalog);

  it('matches on barcode exactly and offers no alternatives', () => {
    const hits = index.find('нечитаемая строка', '5449000000996');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({productId: 'p1', by: 'barcode', score: 1});
  });

  it('ignores separators inside a barcode', () => {
    expect(index.find('x', '5449-0000-00996')[0]?.productId).toBe('p1');
  });

  it('matches on an internal SKU', () => {
    expect(index.find('x', 'sut-001')[0]).toMatchObject({
      productId: 'p3',
      by: 'code',
    });
  });

  it('matches a Cyrillic invoice name to a Latin catalogue name', () => {
    const [best] = index.find('Кока-Кола 1л', null);
    expect(best.productId).toBe('p1');
    expect(best.by).toBe('name');
    expect(best.score).toBeGreaterThan(0.55);
  });

  it('is not thrown off by reordered words', () => {
    expect(index.find('Nestle sut 1 l', null)[0]?.productId).toBe('p3');
  });

  it('ranks the right product above the same-sized runner-up', () => {
    const hits = index.find('Pepsi 1 L', null);
    expect(hits[0].productId).toBe('p2');
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('returns nothing usable for a name that shares no bigrams', () => {
    expect(index.find('zzzz', null)).toHaveLength(0);
  });

  it('returns nothing for a name with no letters at all', () => {
    expect(index.find('###', null)).toHaveLength(0);
  });

  it('caps how many candidates it offers', () => {
    const many = new CatalogIndex(
      Array.from({length: 50}, (_, i) => product(`n${i}`, `Non oddiy ${i}`)),
    );
    expect(many.find('Non oddiy', null).length).toBeLessThanOrEqual(5);
  });

  it('prefers the first product when two share a barcode', () => {
    const dupes = new CatalogIndex([
      product('a', 'A', {barcode: '111'}),
      product('b', 'B', {barcode: '111'}),
    ]);
    expect(dupes.find('x', '111')[0].productId).toBe('a');
  });
});
