import {consumeBatches} from './costing';

// A stand-in for the drizzle transaction handle: it hands back a fixed set of
// lots and records the writes, which is all consumeBatches touches.
function fakeTx(lots: {id: string; priceIn: string; qtyRemaining: number}[]) {
  const drawn: {id: string}[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            for: () => Promise.resolve(lots),
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: (w: unknown) => {
          drawn.push({id: String(w)});
          return Promise.resolve();
        },
      }),
    }),
  };
  return {tx: tx as never, drawn};
}

describe('consumeBatches', () => {
  // The bug this guards: a shop set 5,000 on the card, the delivery had gone in
  // at the 20%-markup figure of 3,720, and the sale charged the lot — then
  // pushed 3,720 back onto the card. The lot's own selling price is a record of
  // the delivery note and must not reach the customer.
  it('sells at the card price, whatever the lots were delivered at', async () => {
    const {tx} = fakeTx([{id: 'lot-3720', priceIn: '3100', qtyRemaining: 10}]);
    const c = await consumeBatches(
      tx,
      'biz',
      'orbit',
      2,
      'FIFO',
      3100, // weighted-average cost
      5000, // the card price
    );
    expect(c.priceOut).toBe(5000);
    expect(c.revenueTotal).toBe(10000);
  });

  it('costs a line across lots at what each lot was bought for (FIFO)', async () => {
    const {tx} = fakeTx([
      {id: 'old', priceIn: '3000', qtyRemaining: 2},
      {id: 'new', priceIn: '4000', qtyRemaining: 5},
    ]);
    const c = await consumeBatches(tx, 'biz', 'orbit', 3, 'FIFO', 3500, 5000);
    // 2 at 3,000 + 1 at 4,000 — cost follows the lots even though price does not.
    expect(c.costTotal).toBe(10000);
    expect(c.costIn).toBe(3333.33);
    expect(c.revenueTotal).toBe(15000);
  });

  it('uses the average cost for every unit under AVERAGE costing', async () => {
    const {tx} = fakeTx([
      {id: 'old', priceIn: '3000', qtyRemaining: 2},
      {id: 'new', priceIn: '4000', qtyRemaining: 5},
    ]);
    const c = await consumeBatches(tx, 'biz', 'orbit', 3, 'AVERAGE', 3500, 5000);
    expect(c.costTotal).toBe(10500);
    expect(c.costIn).toBe(3500);
  });

  it('prices a chosen tier flat and leaves the cost alone', async () => {
    const {tx} = fakeTx([{id: 'lot', priceIn: '3100', qtyRemaining: 10}]);
    const c = await consumeBatches(
      tx,
      'biz',
      'orbit',
      4,
      'FIFO',
      3100,
      5000,
      null,
      4500, // wholesale
    );
    expect(c.revenueTotal).toBe(18000);
    expect(c.priceOut).toBe(4500);
    expect(c.costTotal).toBe(12400);
  });

  // Overselling values the uncovered units at the product's own cost; they are
  // sold at the same card price as the units that did come out of a lot.
  it('sells the uncovered part of an oversell at the card price too', async () => {
    const {tx} = fakeTx([{id: 'lot', priceIn: '3000', qtyRemaining: 1}]);
    const c = await consumeBatches(tx, 'biz', 'orbit', 3, 'FIFO', 3500, 5000);
    expect(c.revenueTotal).toBe(15000);
    expect(c.costTotal).toBe(10000); // 1 × 3,000 + 2 × 3,500
  });

  it('weighs a fractional line to the so’m', async () => {
    const {tx} = fakeTx([{id: 'lot', priceIn: '12000', qtyRemaining: 5}]);
    const c = await consumeBatches(tx, 'biz', 'gosht', 0.325, 'FIFO', 12000, 20000);
    expect(c.revenueTotal).toBe(6500);
  });
});
