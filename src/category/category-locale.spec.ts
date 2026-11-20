import {catalogLocaleOf, parseCatalogLocale} from './category-locale';

describe('parseCatalogLocale', () => {
  it.each([
    ['uz', 'uz'],
    ['uz-Cyrl', 'uzc'],
    ['uz-Cyrl-UZ,uz;q=0.9', 'uzc'],
    ['uzc', 'uzc'],
    ['ru', 'ru'],
    ['ru-RU,ru;q=0.9,en;q=0.8', 'ru'],
    ['en-US', 'en'],
    ['de-DE,ru;q=0.9', 'uz'],
    ['', 'uz'],
    [undefined, 'uz'],
  ])('%s → %s', (header, expected) => {
    expect(parseCatalogLocale(header)).toBe(expected);
  });
});

describe('catalogLocaleOf', () => {
  it('lets an explicit ?locale= win', () => {
    expect(catalogLocaleOf('ru', 'en')).toBe('ru');
    expect(catalogLocaleOf('uzc', undefined)).toBe('uzc');
  });

  it('falls back to the header for a missing or unknown query', () => {
    expect(catalogLocaleOf(undefined, 'en')).toBe('en');
    expect(catalogLocaleOf('fr', 'ru-RU')).toBe('ru');
  });
});
