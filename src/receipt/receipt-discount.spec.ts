import {netUnitPrice, resolveDiscount} from './receipt-discount';

describe('resolveDiscount', () => {
  it('keeps a typed amount as it is', () => {
    expect(resolveDiscount(1970839.99, {discountAmount: 157667})).toEqual({
      amount: 157667,
      pct: null,
    });
  });

  it('derives the amount from a percent, which then drives', () => {
    expect(resolveDiscount(1970839.99, {discountPct: 8})).toEqual({
      amount: 157667.2,
      pct: 8,
    });
  });

  it('lets the percent win over an amount sent alongside it', () => {
    expect(
      resolveDiscount(1000, {discountPct: 10, discountAmount: 50}),
    ).toEqual({amount: 100, pct: 10});
  });

  it('reads no discount, a zero percent and a zero amount as none', () => {
    expect(resolveDiscount(1000, {})).toEqual({amount: 0, pct: null});
    expect(resolveDiscount(1000, {discountPct: 0, discountAmount: 50})).toEqual(
      {amount: 0, pct: null},
    );
    expect(resolveDiscount(1000, {discountAmount: 0})).toEqual({
      amount: 0,
      pct: null,
    });
  });
});

describe('netUnitPrice', () => {
  it('takes the same fraction off every line', () => {
    // 10 lines of 1 000 000, 1 000 000 off → 900 000 each.
    expect(netUnitPrice(1_000_000, 10_000_000, 1_000_000)).toBe(900_000);
  });

  it('spreads the photographed nakladnoy (Скидка 8% = 157 667,00)', () => {
    const gross = 1970839.99;
    expect(netUnitPrice(89700, gross, 157667)).toBe(82524.01);
    expect(netUnitPrice(25700, gross, 157667)).toBe(23644);
  });

  it('leaves the price alone with no discount or no gross', () => {
    expect(netUnitPrice(5000, 10000, 0)).toBe(5000);
    expect(netUnitPrice(5000, 0, 100)).toBe(5000);
  });

  it('brings a fully discounted line to zero', () => {
    expect(netUnitPrice(5000, 10000, 10000)).toBe(0);
  });
});
