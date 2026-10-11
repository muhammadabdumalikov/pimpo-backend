import {itemCountOf} from './item-count';

describe('itemCountOf', () => {
  it('counts whole pieces as themselves', () => {
    expect(itemCountOf(12, 'piece')).toBe(12);
    expect(itemCountOf(3, null)).toBe(3);
  });

  it('counts weighed goods as one item', () => {
    expect(itemCountOf(2.5, 'kg')).toBe(1);
    expect(itemCountOf(4, 'kg')).toBe(1);
  });

  it('counts a fractional quantity as one item whatever the card says', () => {
    expect(itemCountOf(2.5, 'piece')).toBe(1);
    expect(itemCountOf(0.347, null)).toBe(1);
    expect(itemCountOf(1.5, undefined)).toBe(1);
  });
});
