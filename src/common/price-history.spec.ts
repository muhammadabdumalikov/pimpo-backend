import {recordPriceChangesTx} from './price-history';

// Records what would be inserted, which is all this helper does.
function fakeTx() {
  const inserted: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({
      values: (rows: Record<string, unknown>[]) => {
        inserted.push(...rows);
        return Promise.resolve();
      },
    }),
  };
  return {tx: tx as never, inserted};
}

const base = {
  businessId: 'biz',
  productId: 'orbit',
  origin: {source: 'card' as const},
  actor: {id: 'staff-1', name: 'Dilshod'},
};

describe('recordPriceChangesTx', () => {
  it('writes one row per price that actually moved', async () => {
    const {tx, inserted} = fakeTx();
    await recordPriceChangesTx(tx, {
      ...base,
      before: {priceOut: '3720.00', priceWholesale: '3500.00'},
      after: {priceOut: '5000.00', priceWholesale: '3500.00'},
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      field: 'priceOut',
      oldPrice: '3720.00',
      newPrice: '5000.00',
      source: 'card',
      cashierName: 'Dilshod',
    });
  });

  it('writes nothing when the edit leaves the prices where they were', async () => {
    const {tx, inserted} = fakeTx();
    await recordPriceChangesTx(tx, {
      ...base,
      before: {priceOut: '5000.00'},
      after: {priceOut: '5000.00', priceWholesale: null},
    });
    expect(inserted).toHaveLength(0);
  });

  it('records a tier priced for the first time, with no old price', async () => {
    const {tx, inserted} = fakeTx();
    await recordPriceChangesTx(tx, {
      ...base,
      before: {priceOut: '5000.00', priceWholesale: null},
      after: {priceWholesale: '4500.00'},
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      field: 'priceWholesale',
      oldPrice: null,
      newPrice: '4500.00',
    });
  });

  it('carries the receipt a price came from', async () => {
    const {tx, inserted} = fakeTx();
    await recordPriceChangesTx(tx, {
      ...base,
      origin: {source: 'receipt', receiptId: 'rec-1'},
      before: {priceOut: '5000.00'},
      after: {priceOut: '5500.00'},
    });
    expect(inserted[0]).toMatchObject({source: 'receipt', receiptId: 'rec-1'});
  });

  // Two decimals of money: a sub-tiyin difference is the same price, not a
  // change worth a row.
  it('ignores a rounding-level difference', async () => {
    const {tx, inserted} = fakeTx();
    await recordPriceChangesTx(tx, {
      ...base,
      before: {priceOut: '5000.00'},
      after: {priceOut: '5000.001'},
    });
    expect(inserted).toHaveLength(0);
  });
});
