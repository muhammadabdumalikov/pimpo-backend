import {reconcilePayments, TenderLine} from './payment-reconcile';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';

const cash = (amount: number): TenderLine => ({method: 'cash', amount});
const card = (amount: number): TenderLine => ({method: 'card', amount});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as AppException).code;
  }
  return 'NO_THROW';
};

describe('reconcilePayments', () => {
  it('books an exact cash payment as it came', () => {
    const r = reconcilePayments({
      payable: 18524,
      payments: [cash(18524)],
      tendered: 18524,
      strict: true,
    });
    expect(r.payments).toEqual([cash(18524)]);
    expect(r.amountPaid).toBe(18524);
    expect(r.changeAmount).toBe(0);
  });

  // The receipt that started this: a 20 000 note for an 18 524 sale was booked
  // as 20 000 of takings, so the drawer came up 1 476 short at close.
  it('treats cash over the total as change, not revenue', () => {
    const r = reconcilePayments({
      payable: 18524,
      payments: [cash(20000)],
      tendered: 20000,
      strict: true,
    });
    expect(r.payments).toEqual([cash(18524)]);
    expect(r.amountPaid).toBe(20000);
    expect(r.changeAmount).toBe(1476);
  });

  it('refuses a sale short of its total', () => {
    expect(
      codeOf(() =>
        reconcilePayments({
          payable: 11028,
          payments: [cash(11000)],
          tendered: 11000,
          strict: true,
        }),
      ),
    ).toBe(ErrorCode.ORDER_UNDERPAID);
  });

  it('refuses a card tender over the total (a card gives no change)', () => {
    expect(
      codeOf(() =>
        reconcilePayments({
          payable: 3720,
          payments: [card(5000)],
          strict: true,
        }),
      ),
    ).toBe(ErrorCode.ORDER_NON_CASH_EXCEEDS_TOTAL);
  });

  it('clamps only the cash leg of a split, leaving the card leg alone', () => {
    const r = reconcilePayments({
      payable: 50000,
      payments: [card(30000), cash(25000)],
      tendered: 25000,
      strict: true,
    });
    expect(r.payments).toEqual([card(30000), cash(20000)]);
    expect(r.amountPaid).toBe(25000);
    expect(r.changeAmount).toBe(5000);
  });

  it('drops a cash row the other tenders already covered', () => {
    const r = reconcilePayments({
      payable: 10000,
      payments: [card(10000), cash(5000)],
      tendered: 5000,
      strict: true,
    });
    expect(r.payments).toEqual([card(10000)]);
    expect(r.changeAmount).toBe(5000);
  });

  it('spreads the clamp across two cash rows in order', () => {
    const r = reconcilePayments({
      payable: 7000,
      payments: [cash(5000), cash(4000)],
      tendered: 9000,
      strict: true,
    });
    expect(r.payments).toEqual([cash(5000), cash(2000)]);
    expect(r.changeAmount).toBe(2000);
  });

  // The till rounds what it displays; a few tiyin either way is that rounding.
  it('lets a sub-so’m difference pass', () => {
    const r = reconcilePayments({
      payable: 11028.3,
      payments: [cash(11028)],
      tendered: 11028,
      strict: true,
    });
    expect(r.payments).toEqual([cash(11028)]);
    expect(r.changeAmount).toBe(0);
  });

  // An offline sale already happened at the counter; refusing it on sync would
  // drop a real sale out of the books.
  it('records an offline sale that is short instead of refusing it', () => {
    const r = reconcilePayments({
      payable: 11028,
      payments: [cash(11000)],
      tendered: 11000,
      strict: false,
    });
    expect(r.payments).toEqual([cash(11000)]);
    expect(r.amountPaid).toBe(11000);
    expect(r.changeAmount).toBe(0);
  });

  it('still clamps the cash on an offline sale', () => {
    const r = reconcilePayments({
      payable: 18524,
      payments: [cash(20000)],
      tendered: 20000,
      strict: false,
    });
    expect(r.payments).toEqual([cash(18524)]);
    expect(r.changeAmount).toBe(1476);
  });

  it('falls back to the cash rows when the till reports no tender', () => {
    const r = reconcilePayments({
      payable: 5000,
      payments: [cash(10000)],
      strict: true,
    });
    expect(r.payments).toEqual([cash(5000)]);
    expect(r.amountPaid).toBe(10000);
    expect(r.changeAmount).toBe(5000);
  });

  it('never reports negative change when the till under-reports the tender', () => {
    const r = reconcilePayments({
      payable: 9000,
      payments: [cash(9000)],
      tendered: 0,
      strict: true,
    });
    expect(r.amountPaid).toBe(9000);
    expect(r.changeAmount).toBe(0);
  });
});
