import {buildStoreOrderMessage, storeLocale} from './store-order-messages';

const base = {
  orderId: 'abcdef12-3456-7890',
  shopName: 'Salom market',
  deliveryType: 'delivery' as const,
  itemCount: 3,
  totalAmount: '100000',
  deliveryFee: '15000',
};

describe('buildStoreOrderMessage', () => {
  it('adds the delivery fee to what the customer pays', () => {
    const text = buildStoreOrderMessage({...base, kind: 'Assembling'})!;
    expect(text).toContain("yig'ilmoqda");
    expect(text).toContain('#ABCDEF12');
    expect(text).toMatch(/Yetkazish: 15.000 so'm/);
    expect(text).toMatch(/To'lov: 115.000 so'm/);
    expect(text).toContain('🏪 Salom market');
  });

  it('names the courier on the way out', () => {
    const text = buildStoreOrderMessage({
      ...base,
      kind: 'Delivering',
      courierName: 'Aziz',
      courierPhone: '+998901234567',
    })!;
    expect(text).toContain('Kuryer: Aziz');
    expect(text).toContain('+998901234567');
  });

  it('says delivered or handed over by fulfilment type', () => {
    expect(buildStoreOrderMessage({...base, kind: 'Completed'})).toContain(
      'yetkazildi',
    );
    expect(
      buildStoreOrderMessage({
        ...base,
        kind: 'Completed',
        deliveryType: 'pickup',
        deliveryFee: 0,
      }),
    ).toContain('topshirildi');
  });

  it('gives the pickup place', () => {
    const text = buildStoreOrderMessage({
      ...base,
      kind: 'ReadyForPickup',
      deliveryType: 'pickup',
      deliveryFee: 0,
      pickupBranchName: 'Chilonzor',
      pickupAddress: 'Bunyodkor 1',
    })!;
    expect(text).toContain('📍 Chilonzor, Bunyodkor 1');
    expect(text).not.toContain('Yetkazish:');
  });

  it('explains a cancel, but stays silent when the customer cancelled', () => {
    expect(
      buildStoreOrderMessage({
        ...base,
        kind: 'Cancelled',
        cancelReason: 'out_of_stock',
      }),
    ).toContain('Sabab: tovar qolmagan');
    expect(
      buildStoreOrderMessage({
        ...base,
        kind: 'Cancelled',
        cancelReason: 'other',
        cancelNote: "Do'kon yopiq",
      }),
    ).toContain("Sabab: Do'kon yopiq");
    expect(
      buildStoreOrderMessage({
        ...base,
        kind: 'Cancelled',
        cancelReason: 'customer_cancelled',
      }),
    ).toBeNull();
  });

  it('lists trimmed lines', () => {
    const text = buildStoreOrderMessage({
      ...base,
      kind: 'ItemsChanged',
      changes: [
        {name: 'Non', from: 3, to: 2},
        {name: 'Sut', from: 1, to: 0},
      ],
    })!;
    expect(text).toContain('➖ Non: 3 → 2');
    expect(text).toContain('➖ Sut: olib tashlandi');
    expect(buildStoreOrderMessage({...base, kind: 'ItemsChanged'})).toBeNull();
  });

  it('speaks the shopper locale and falls back to uz', () => {
    expect(
      buildStoreOrderMessage({...base, kind: 'Assembling', locale: 'ru'}),
    ).toContain('принят');
    expect(
      buildStoreOrderMessage({...base, kind: 'Assembling', locale: 'uzc'}),
    ).toContain('қабул');
    expect(storeLocale('de')).toBe('uz');
    expect(storeLocale(null)).toBe('uz');
  });
});
