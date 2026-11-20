import {mergeSellerTotals} from './seller-totals';

describe('mergeSellerTotals', () => {
  it('nets returns off the person the sale was credited to', () => {
    const out = mergeSellerTotals(
      [
        {staffId: 'a', name: 'Aziz', orderCount: '18', revenue: '2190000.00'},
        {staffId: 'd', name: 'Dilnoza', orderCount: 30, revenue: '3230000'},
      ],
      [{staffId: 'a', name: 'Aziz', value: '50000'}],
    );
    expect(out).toEqual([
      {
        staffId: 'd',
        name: 'Dilnoza',
        orderCount: 30,
        revenue: 3230000,
        returns: 0,
      },
      {
        staffId: 'a',
        name: 'Aziz',
        orderCount: 18,
        revenue: 2140000,
        returns: 50000,
      },
    ]);
  });

  it('lists someone with only a return in the shift, below zero', () => {
    const out = mergeSellerTotals(
      [{staffId: 'a', name: 'Aziz', orderCount: 1, revenue: 100}],
      [{staffId: 'x', name: 'Olim', value: 40}],
    );
    expect(out[1]).toEqual({
      staffId: 'x',
      name: 'Olim',
      orderCount: 0,
      revenue: -40,
      returns: 40,
    });
  });

  it('keeps sales nobody is credited with as their own row', () => {
    const out = mergeSellerTotals(
      [{staffId: null, name: null, orderCount: 2, revenue: 500}],
      [{staffId: null, name: null, value: 100}],
    );
    expect(out).toEqual([
      {staffId: null, name: null, orderCount: 2, revenue: 400, returns: 100},
    ]);
  });
});
