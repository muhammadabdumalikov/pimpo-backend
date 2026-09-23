import {resolveLinePrice} from './quoted-price';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';

// A line of 3 at the card price of 5,508. The lots behind it may have been
// bought at any number of different costs — none of that reaches the price.
const line = {
  quantity: 3,
  lineRevenue: 16524,
  cardPrice: 5508,
  productName: 'Milky Way',
  strict: true,
};

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as AppException).code;
  }
  return 'NO_THROW';
};

describe('resolveLinePrice', () => {
  it('uses the card price when the till quoted nothing', () => {
    expect(resolveLinePrice({...line, quoted: null})).toEqual({
      revenueTotal: 16524,
      priceOut: 5508,
    });
  });

  it('honours a quote that matches the card', () => {
    expect(resolveLinePrice({...line, quoted: 5508})).toEqual({
      revenueTotal: 16524,
      priceOut: 5508,
    });
  });

  // The band used to stretch across every lot the line drew on, so a stale
  // screen showing an old delivery's price was accepted. One price, one figure.
  it('refuses a quote the card does not name, high or low', () => {
    expect(codeOf(() => resolveLinePrice({...line, quoted: 3720}))).toBe(
      ErrorCode.ORDER_PRICE_NOT_BACKED,
    );
    expect(codeOf(() => resolveLinePrice({...line, quoted: 9000}))).toBe(
      ErrorCode.ORDER_PRICE_NOT_BACKED,
    );
  });

  it('refuses a token price outright', () => {
    expect(codeOf(() => resolveLinePrice({...line, quoted: 1}))).toBe(
      ErrorCode.ORDER_PRICE_NOT_BACKED,
    );
  });

  // Repricing without a delivery: the card goes to 7,000 while the lot on the
  // shelf still records the 6,000 it was delivered at. The sale is at 7,000.
  it('sells at the card price when the lots record an older figure', () => {
    const repriced = {
      quantity: 1,
      lineRevenue: 7000,
      cardPrice: 7000,
      productName: 'Flavis nok',
      strict: true,
    };
    expect(resolveLinePrice({...repriced, quoted: 7000})).toEqual({
      revenueTotal: 7000,
      priceOut: 7000,
    });
    // A price cut works the same way.
    expect(
      resolveLinePrice({
        ...repriced,
        lineRevenue: 5000,
        cardPrice: 5000,
        quoted: 5000,
      }),
    ).toEqual({revenueTotal: 5000, priceOut: 5000});
  });

  // A card with no price set says nothing, and must not open the floor to 0:
  // the line's own value stands in for it.
  it('ignores a zero card price', () => {
    expect(
      codeOf(() => resolveLinePrice({...line, cardPrice: 0, quoted: 0})),
    ).toBe(ErrorCode.ORDER_PRICE_NOT_BACKED);
  });

  it('lets a sub-so’m difference through, and books the card price', () => {
    expect(resolveLinePrice({...line, quoted: 5507.7})).toEqual({
      revenueTotal: 16524,
      priceOut: 5508,
    });
  });

  // An offline sale already happened; the unbacked quote is dropped, not the sale.
  it('falls back to the card for an offline sale instead of refusing it', () => {
    expect(resolveLinePrice({...line, strict: false, quoted: 3720})).toEqual({
      revenueTotal: 16524,
      priceOut: 5508,
    });
  });

  it('still honours a matching quote on an offline sale', () => {
    expect(resolveLinePrice({...line, strict: false, quoted: 5508})).toEqual({
      revenueTotal: 16524,
      priceOut: 5508,
    });
  });

  it('rounds a weighed line to the so’m', () => {
    const r = resolveLinePrice({
      quantity: 0.325,
      lineRevenue: 6500,
      cardPrice: 20000,
      productName: 'Go‘sht',
      strict: true,
      quoted: 20000,
    });
    expect(r.revenueTotal).toBe(6500);
  });
});
