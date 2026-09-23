import {priceFlags, isSevere} from './price-risk';

// Figures from the shop that reported the bug: Orbit around 5 000, the Kaplya
// apple card at 15 000 with 150 000 typed on a delivery line.
describe('priceFlags', () => {
  it('says nothing about an ordinary repricing', () => {
    expect(priceFlags({card: 5000, proposed: 5200, cost: 4000})).toEqual([]);
  });

  it('says nothing about an ordinary drop', () => {
    expect(priceFlags({card: 8000, proposed: 7500, cost: 6000})).toEqual([]);
  });

  it('catches the missing zero in both directions', () => {
    expect(priceFlags({card: 15000, proposed: 150000, cost: 12000})).toEqual([
      'magnitude',
    ]);
    expect(priceFlags({card: 150000, proposed: 15000, cost: 1000})).toEqual([
      'magnitude',
    ]);
  });

  it('catches a hundredfold slip', () => {
    expect(priceFlags({card: 5000, proposed: 500000, cost: 4000})).toEqual([
      'magnitude',
    ]);
  });

  it('does not call a magnitude slip large as well', () => {
    // One thing is wrong with the row, so the row names one reason.
    expect(priceFlags({card: 15000, proposed: 150000, cost: 12000})).not.toContain(
      'large',
    );
  });

  it('catches a price under cost, however small the move', () => {
    expect(priceFlags({card: 5000, proposed: 4500, cost: 5000})).toEqual([
      'belowCost',
    ]);
  });

  it('judges a card with no price by cost alone', () => {
    expect(priceFlags({card: null, proposed: 4500, cost: 5000})).toEqual([
      'belowCost',
    ]);
    // A first price above cost is a new product, not a risk.
    expect(priceFlags({card: null, proposed: 6000, cost: 5000})).toEqual([]);
  });

  it('flags a move of half again, but not the ±50% that deliveries make weekly', () => {
    expect(priceFlags({card: 10000, proposed: 14000, cost: 8000})).toEqual([]);
    expect(priceFlags({card: 10000, proposed: 15000, cost: 8000})).toEqual([
      'large',
    ]);
    expect(priceFlags({card: 15000, proposed: 10000, cost: 8000})).toEqual([
      'large',
    ]);
  });

  it('can name two reasons at once', () => {
    // 20 000 down to 9 000: a big drop AND under what it cost.
    expect(priceFlags({card: 20000, proposed: 9000, cost: 10000})).toEqual([
      'belowCost',
      'large',
    ]);
  });

  it('ignores a cost it does not have', () => {
    expect(priceFlags({card: 5000, proposed: 5200, cost: null})).toEqual([]);
    expect(priceFlags({card: 5000, proposed: 5200, cost: 0})).toEqual([]);
  });

  it('says nothing about a price of zero — an empty tier is not a risk', () => {
    expect(priceFlags({card: 5000, proposed: 0, cost: 4000})).toEqual([]);
  });
});

describe('isSevere', () => {
  it('holds only for the mistakes that are certain', () => {
    expect(isSevere(['belowCost'])).toBe(true);
    expect(isSevere(['magnitude'])).toBe(true);
    expect(isSevere(['large'])).toBe(false);
    expect(isSevere(['cardMoved'])).toBe(false);
    expect(isSevere([])).toBe(false);
  });
});
