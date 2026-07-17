import {computeReconciliation, type ReconRow} from './reconciliation';

const row = (rows: ReconRow[], method: string, currency = 'UZS') =>
  rows.find((r) => r.method === method && r.currency === currency)!;

describe('computeReconciliation', () => {
  it('opening float only: cash expected equals the float', () => {
    const {rows, orderCount, hasUsd} = computeReconciliation({
      openingFloat: 100000,
      sales: [],
      movements: [],
    });
    expect(orderCount).toBe(0);
    expect(hasUsd).toBe(false);
    const cash = row(rows, 'cash');
    expect(cash.in).toBe(0);
    expect(cash.out).toBe(0);
    expect(cash.expected).toBe(100000);
    expect(cash.counted).toBeNull();
    expect(cash.diff).toBeNull();
    expect(row(rows, 'card').expected).toBe(0);
    expect(row(rows, 'debt').expected).toBe(0);
  });

  it('cash sale increases the cash row', () => {
    const {rows} = computeReconciliation({
      openingFloat: 0,
      sales: [
        {totalAmount: 50000, payments: [{method: 'cash', amount: 50000}]},
      ],
      movements: [],
    });
    expect(row(rows, 'cash').in).toBe(50000);
    expect(row(rows, 'cash').expected).toBe(50000);
    expect(row(rows, 'card').in).toBe(0);
  });

  it('card sale increases the card row only', () => {
    const {rows} = computeReconciliation({
      openingFloat: 0,
      sales: [
        {totalAmount: 30000, payments: [{method: 'card', amount: 30000}]},
      ],
      movements: [],
    });
    expect(row(rows, 'card').in).toBe(30000);
    expect(row(rows, 'cash').in).toBe(0);
  });

  it('split payment is attributed per method', () => {
    const {rows} = computeReconciliation({
      openingFloat: 0,
      sales: [
        {
          totalAmount: 100000,
          payments: [
            {method: 'cash', amount: 60000},
            {method: 'card', amount: 40000},
          ],
        },
      ],
      movements: [],
    });
    expect(row(rows, 'cash').in).toBe(60000);
    expect(row(rows, 'card').in).toBe(40000);
    expect(row(rows, 'debt').in).toBe(0);
  });

  it('full debt sale (no down payment) goes to the debt row', () => {
    const {rows} = computeReconciliation({
      openingFloat: 0,
      sales: [{totalAmount: 44000, payments: []}],
      movements: [],
    });
    expect(row(rows, 'debt').in).toBe(44000);
    expect(row(rows, 'cash').in).toBe(0);
  });

  it('debt sale with a cash down payment splits paid vs owed', () => {
    const {rows} = computeReconciliation({
      openingFloat: 0,
      sales: [
        {totalAmount: 100000, payments: [{method: 'cash', amount: 30000}]},
      ],
      movements: [],
    });
    expect(row(rows, 'cash').in).toBe(30000);
    expect(row(rows, 'debt').in).toBe(70000);
  });

  it('manual cash in/out adjust the cash row', () => {
    const {rows} = computeReconciliation({
      openingFloat: 10000,
      sales: [],
      movements: [
        {isCash: true, currency: 'UZS', type: 'in', amount: 20000},
        {isCash: true, currency: 'UZS', type: 'out', amount: 5000},
      ],
    });
    const cash = row(rows, 'cash');
    expect(cash.in).toBe(20000);
    expect(cash.out).toBe(5000);
    expect(cash.expected).toBe(10000 + 20000 - 5000);
  });

  it('non-cash movements adjust the card row', () => {
    const {rows} = computeReconciliation({
      openingFloat: 0,
      sales: [],
      movements: [{isCash: false, currency: 'UZS', type: 'out', amount: 7000}],
    });
    expect(row(rows, 'card').out).toBe(7000);
    expect(row(rows, 'cash').out).toBe(0);
  });

  it('counted amounts produce the difference (BILLZ example)', () => {
    // Opening 0, cash sales 2 431 880, counted 0 → shortage of the whole amount.
    const counted = new Map<string, number>([['cash:UZS', 0]]);
    const {rows} = computeReconciliation({
      openingFloat: 0,
      sales: [
        {totalAmount: 2431880, payments: [{method: 'cash', amount: 2431880}]},
      ],
      movements: [],
      counted,
    });
    const cash = row(rows, 'cash');
    expect(cash.expected).toBe(2431880);
    expect(cash.counted).toBe(0);
    expect(cash.diff).toBe(-2431880);
  });

  it('counted surplus yields a positive difference', () => {
    const counted = new Map<string, number>([['cash:UZS', 105000]]);
    const {rows} = computeReconciliation({
      openingFloat: 100000,
      sales: [],
      movements: [],
      counted,
    });
    expect(row(rows, 'cash').diff).toBe(5000);
  });

  it('USD activity adds USD rows and flags hasUsd', () => {
    const {rows, hasUsd} = computeReconciliation({
      openingFloat: 0,
      sales: [],
      movements: [{isCash: true, currency: 'USD', type: 'in', amount: 100}],
    });
    expect(hasUsd).toBe(true);
    expect(row(rows, 'cash', 'USD').in).toBe(100);
    // UZS rows still present.
    expect(row(rows, 'cash', 'UZS')).toBeDefined();
  });

  it('handles string amounts (decimal columns) correctly', () => {
    const {rows} = computeReconciliation({
      openingFloat: 0,
      sales: [
        {
          totalAmount: '3438842.8991',
          payments: [{method: 'cash', amount: 3438842.8991}],
        },
      ],
      movements: [],
    });
    expect(row(rows, 'cash').in).toBeCloseTo(3438842.8991, 4);
  });
});

// saleTotals is what closeShift feeds into the finance ledger on close. It must
// contain ONLY sales (manual movements are mirrored separately when they
// happen), otherwise shift_close would double-count them.
describe('computeReconciliation saleTotals (finance ledger source)', () => {
  it('splits sales by method', () => {
    const {saleTotals} = computeReconciliation({
      openingFloat: 0,
      sales: [
        {
          totalAmount: 100000,
          payments: [
            {method: 'cash', amount: 60000},
            {method: 'card', amount: 40000},
          ],
        },
        {totalAmount: 50000, payments: [{method: 'cash', amount: 20000}]},
      ],
      movements: [],
    });
    expect(saleTotals.cashSales).toBe(80000);
    expect(saleTotals.cardSales).toBe(40000);
    expect(saleTotals.debtSales).toBe(30000); // 50000 − 20000 down payment
  });

  it('EXCLUDES manual movements (no double-counting on close)', () => {
    const {saleTotals} = computeReconciliation({
      openingFloat: 0,
      sales: [{totalAmount: 50000, payments: [{method: 'cash', amount: 50000}]}],
      // Big manual movements must NOT leak into saleTotals — they are already
      // recorded as ledger rows by recordCashMovementTx.
      movements: [
        {isCash: true, currency: 'UZS', type: 'in', amount: 999999},
        {isCash: false, currency: 'UZS', type: 'out', amount: 12345},
      ],
    });
    expect(saleTotals.cashSales).toBe(50000);
    expect(saleTotals.cardSales).toBe(0);
    expect(saleTotals.debtSales).toBe(0);
  });

  it('is zero when there are no sales', () => {
    const {saleTotals} = computeReconciliation({
      openingFloat: 100000,
      sales: [],
      movements: [{isCash: true, currency: 'UZS', type: 'in', amount: 20000}],
    });
    expect(saleTotals).toEqual({cashSales: 0, cardSales: 0, debtSales: 0});
  });
});
