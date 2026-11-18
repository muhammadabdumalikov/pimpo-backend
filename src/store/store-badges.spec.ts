import { newBadgesOn, popularSlots } from './store-badges';
import { normalizeOldPrice, visibleOldPrice } from '../product/old-price';
import { readStoreAccent } from '../common/store-accent';

describe('storefront badges', () => {
  it('gives "Ommabop" to at most one card in five, never more than 8', () => {
    expect(popularSlots(4)).toBe(0);
    expect(popularSlots(12)).toBe(2);
    expect(popularSlots(500)).toBe(8);
  });

  it('shows "Yangi" only while new cards are at most half the catalogue', () => {
    expect(newBadgesOn(20, 0)).toBe(false);
    expect(newBadgesOn(20, 10)).toBe(true);
    expect(newBadgesOn(20, 11)).toBe(false);
  });
});

describe('old price', () => {
  it('stores a positive amount, clears blanks and zero', () => {
    expect(normalizeOldPrice(' 150000 ')).toBe('150000.00');
    expect(normalizeOldPrice('')).toBeNull();
    expect(normalizeOldPrice('0')).toBeNull();
    expect(normalizeOldPrice(null)).toBeNull();
  });

  it('is shown only while above the selling price', () => {
    expect(visibleOldPrice('150000.00', '120000.00')).toBe('150000.00');
    expect(visibleOldPrice('120000.00', '120000.00')).toBeNull();
    expect(visibleOldPrice('100000.00', '120000.00')).toBeNull();
    expect(visibleOldPrice(null, '120000.00')).toBeNull();
  });
});

describe('store accent', () => {
  it('accepts palette keys, clears blanks, rejects the rest', () => {
    expect(readStoreAccent(' Rose ')).toBe('rose');
    expect(readStoreAccent('')).toBeNull();
    expect(readStoreAccent(null)).toBeNull();
    expect(readStoreAccent('#ff0000')).toBeUndefined();
  });
});
