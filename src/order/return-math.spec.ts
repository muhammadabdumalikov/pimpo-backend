import {computeReturn, ReturnInput, ReturnLineInput} from './return-math';

const line = (over: Partial<ReturnLineInput>): ReturnLineInput => ({
  orderItemId: 'i1',
  soldQty: 3,
  lineTotal: 30000,
  costTotal: 18000,
  returnedQty: 0,
  returnedGross: 0,
  returnedCost: 0,
  isKg: false,
  requestQty: 0,
  restock: true,
  ...over,
});

const base = (over: Partial<ReturnInput>): ReturnInput => ({
  orderSubtotal: 30000,
  orderTotal: 30000,
  orderReturnedAmount: 0,
  lines: [],
  debtRemaining: 0,
  pointsRedeemed: 0,
  pointsRestoredSoFar: 0,
  pointsEarned: 0,
  pointsReversedSoFar: 0,
  ...over,
});

describe('computeReturn', () => {
  it('values a partial line at its pro-rata price and refunds it as money', () => {
    const r = computeReturn(base({lines: [line({requestQty: 1})]}));
    expect(r.totalAmount).toBe(10000);
    expect(r.refundAmount).toBe(10000);
    expect(r.costTotal).toBe(6000);
    expect(r.restockedCost).toBe(6000);
    expect(r.itemCount).toBe(1);
    expect(r.isFinal).toBe(false);
  });

  it('spreads the order discount over returned lines', () => {
    // 10% off: 30 000 → 27 000.
    const r = computeReturn(
      base({orderTotal: 27000, lines: [line({requestQty: 1})]}),
    );
    expect(r.grossAmount).toBe(10000);
    expect(r.totalAmount).toBe(9000);
    expect(r.discountAmount).toBe(1000);
  });

  it('nets a receipt returned in several goes back to the exact total', () => {
    // 3 × 3 333.33 with a discount that leaves awkward cents.
    const common = {orderSubtotal: 10000, orderTotal: 9999.99};
    const first = computeReturn(
      base({
        ...common,
        lines: [line({soldQty: 3, lineTotal: 10000, costTotal: 0, requestQty: 1})],
      }),
    );
    const second = computeReturn(
      base({
        ...common,
        orderReturnedAmount: first.totalAmount,
        lines: [
          line({
            soldQty: 3,
            lineTotal: 10000,
            costTotal: 0,
            returnedQty: 1,
            returnedGross: first.grossAmount,
            requestQty: 2,
          }),
        ],
      }),
    );
    expect(second.isFinal).toBe(true);
    expect(first.totalAmount + second.totalAmount).toBeCloseTo(9999.99, 2);
    expect(first.grossAmount + second.grossAmount).toBeCloseTo(10000, 2);
  });

  it('shrinks the open debt before refunding any money', () => {
    const r = computeReturn(
      base({debtRemaining: 7000, lines: [line({requestQty: 1})]}),
    );
    expect(r.debtReduced).toBe(7000);
    expect(r.refundAmount).toBe(3000);
  });

  it('gives spent points back after the debt, then money', () => {
    const r = computeReturn(
      base({
        debtRemaining: 4000,
        pointsRedeemed: 5000,
        lines: [line({requestQty: 1})],
      }),
    );
    expect(r.debtReduced).toBe(4000);
    expect(r.pointsRestored).toBe(5000);
    expect(r.refundAmount).toBe(1000);
  });

  it('never restores more points than were spent across returns', () => {
    const r = computeReturn(
      base({
        pointsRedeemed: 5000,
        pointsRestoredSoFar: 4500,
        lines: [line({requestQty: 1})],
      }),
    );
    expect(r.pointsRestored).toBe(500);
    expect(r.refundAmount).toBe(9500);
  });

  it('takes earned cashback back pro rata, and all of it on the final return', () => {
    const partial = computeReturn(
      base({pointsEarned: 900, lines: [line({requestQty: 1})]}),
    );
    expect(partial.pointsReversed).toBe(300);
    const final = computeReturn(
      base({
        pointsEarned: 900,
        pointsReversedSoFar: 300,
        orderReturnedAmount: 10000,
        lines: [
          line({
            returnedQty: 1,
            returnedGross: 10000,
            returnedCost: 6000,
            requestQty: 2,
          }),
        ],
      }),
    );
    expect(final.pointsReversed).toBe(600);
  });

  it('keeps a defective line out of restocked cost and counts kg lines once', () => {
    const r = computeReturn(
      base({
        orderSubtotal: 48000,
        orderTotal: 48000,
        lines: [
          line({requestQty: 1, restock: false}),
          line({
            orderItemId: 'i2',
            soldQty: 1.5,
            lineTotal: 18000,
            costTotal: 12000,
            isKg: true,
            requestQty: 0.5,
          }),
        ],
      }),
    );
    expect(r.costTotal).toBe(10000);
    expect(r.restockedCost).toBe(4000);
    expect(r.itemCount).toBe(2);
  });
});
