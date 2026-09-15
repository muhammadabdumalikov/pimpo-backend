import {resolveLinePrice} from './quoted-price';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';

// A line drawn from one lot at 5,508 — the ordinary case.
const oneLot = {
  quantity: 3,
  batchRevenue: 16524,
  batchUnitPrice: 5508,
  minLotPrice: 5508,
  maxLotPrice: 5508,
  productName: 'Milky Way',
  strict: true,
};

// The same line running past the end of the front lot: 2 at 5,508 + 1 at 6,000.
const twoLots = {
  quantity: 3,
  batchRevenue: 17016,
  batchUnitPrice: 5672,
  minLotPrice: 5508,
  maxLotPrice: 6000,
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
  it('prices per batch when the till quoted nothing', () => {
    expect(resolveLinePrice({...twoLots, quoted: null})).toEqual({
      revenueTotal: 17016,
      priceOut: 5672,
    });
  });

  // The case that made screen and paper disagree: the till showed the front
  // lot's price for all three, the sale blended in the dearer lot behind it.
  it('honours the quoted price when the lots carry it', () => {
    expect(resolveLinePrice({...twoLots, quoted: 5508})).toEqual({
      revenueTotal: 16524,
      priceOut: 5508,
    });
  });

  it('honours the dearer end of the band too', () => {
    expect(resolveLinePrice({...twoLots, quoted: 6000})).toEqual({
      revenueTotal: 18000,
      priceOut: 6000,
    });
  });

  it('refuses a price no lot behind the line carries', () => {
    expect(codeOf(() => resolveLinePrice({...twoLots, quoted: 4000}))).toBe(
      ErrorCode.ORDER_PRICE_NOT_BACKED,
    );
    expect(codeOf(() => resolveLinePrice({...twoLots, quoted: 9000}))).toBe(
      ErrorCode.ORDER_PRICE_NOT_BACKED,
    );
  });

  // A client naming its own figure is the reason the band exists at all.
  it('refuses a token price outright', () => {
    expect(codeOf(() => resolveLinePrice({...oneLot, quoted: 1}))).toBe(
      ErrorCode.ORDER_PRICE_NOT_BACKED,
    );
  });

  // Repricing without a delivery: the card goes to 7,000, the lot on the shelf
  // still wears 6,000. This used to refuse every sale of the line.
  it('honours the card price when no lot has caught up with it', () => {
    const repriced = {
      quantity: 1,
      batchRevenue: 6000,
      batchUnitPrice: 6000,
      minLotPrice: 6000,
      maxLotPrice: 6000,
      cardPrice: 7000,
      productName: 'Flavis nok',
      strict: true,
    };
    expect(resolveLinePrice({...repriced, quoted: 7000})).toEqual({
      revenueTotal: 7000,
      priceOut: 7000,
    });
    // A price cut works the same way, from the other side of the lot.
    expect(
      resolveLinePrice({...repriced, cardPrice: 5000, quoted: 5000}),
    ).toEqual({revenueTotal: 5000, priceOut: 5000});
    // The band still has ends: the card widened it, it did not remove it.
    expect(
      codeOf(() => resolveLinePrice({...repriced, quoted: 9000})),
    ).toBe(ErrorCode.ORDER_PRICE_NOT_BACKED);
  });

  // A card with no price set says nothing, and must not open the floor to 0.
  it('ignores a zero card price', () => {
    expect(
      codeOf(() => resolveLinePrice({...oneLot, cardPrice: 0, quoted: 0})),
    ).toBe(ErrorCode.ORDER_PRICE_NOT_BACKED);
  });

  it('agrees with the batch price when a single lot covers the line', () => {
    expect(resolveLinePrice({...oneLot, quoted: 5508})).toEqual({
      revenueTotal: 16524,
      priceOut: 5508,
    });
  });

  it('lets a sub-so’m difference through', () => {
    const r = resolveLinePrice({...oneLot, quoted: 5507.7});
    expect(r.priceOut).toBe(5507.7);
  });

  // An offline sale already happened; the unbacked quote is dropped, not the sale.
  it('falls back to the lots for an offline sale instead of refusing it', () => {
    expect(resolveLinePrice({...twoLots, strict: false, quoted: 4000})).toEqual(
      {revenueTotal: 17016, priceOut: 5672},
    );
  });

  it('still honours a backed quote on an offline sale', () => {
    expect(resolveLinePrice({...twoLots, strict: false, quoted: 5508})).toEqual(
      {revenueTotal: 16524, priceOut: 5508},
    );
  });

  it('rounds a weighed line to the so’m', () => {
    const r = resolveLinePrice({
      quantity: 0.325,
      batchRevenue: 6500,
      batchUnitPrice: 20000,
      minLotPrice: 20000,
      maxLotPrice: 20000,
      productName: 'Go‘sht',
      strict: true,
      quoted: 20000,
    });
    expect(r.revenueTotal).toBe(6500);
  });
});
