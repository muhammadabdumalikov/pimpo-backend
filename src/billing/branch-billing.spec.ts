import {
  BRANCH_FREE_MS,
  branchBillingState,
  fitRenewal,
  type BranchBillingRow,
  type BranchBillingSub,
} from './branch-billing';

const DAY = 86_400_000;
const T0 = new Date('2026-11-20T06:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

const sub = (endInDays: number, isTrial = false): BranchBillingSub => ({
  endDate: at(endInDays),
  isTrial,
});

const opened = (over: Partial<BranchBillingRow> = {}): BranchBillingRow => ({
  isDefault: false,
  createdAt: T0,
  freeUntil: new Date(T0.getTime() + BRANCH_FREE_MS),
  paidUntil: null,
  renew: true,
  ...over,
});

describe('branchBillingState', () => {
  it('the main store follows the plan', () => {
    expect(branchBillingState(opened({isDefault: true}), sub(10), T0).state).toBe('main');
  });

  it('a trial or an open-ended plan covers every store', () => {
    expect(branchBillingState(opened(), sub(10, true), at(5)).state).toBe('covered');
    expect(branchBillingState(opened(), {endDate: null, isTrial: false}, at(5)).state).toBe(
      'covered',
    );
    expect(branchBillingState(opened(), null, at(5)).state).toBe('covered');
  });

  it('is free for three days, then warns for three, then closes', () => {
    const b = opened();
    const s = sub(20);
    expect(branchBillingState(b, s, at(2.9)).state).toBe('free');
    const warn = branchBillingState(b, s, at(3.1));
    expect(warn.state).toBe('warning');
    expect(warn.closesAt).toEqual(at(6));
    expect(branchBillingState(b, s, at(5.9)).state).toBe('warning');
    expect(branchBillingState(b, s, at(6)).state).toBe('closed');
  });

  it('is paid while settled to the period end, even past it (renewal pending)', () => {
    const b = opened({paidUntil: at(20)});
    expect(branchBillingState(b, sub(20), at(10)).state).toBe('paid');
    expect(branchBillingState(b, sub(20), at(20.2)).state).toBe('paid');
  });

  it('a renewal that left it out starts its warning from the renewal', () => {
    // Period renewed to day 50; the store was marked due at the renewal (day 20).
    const b = opened({paidUntil: at(20)});
    expect(branchBillingState(b, sub(50), at(21)).state).toBe('warning');
    expect(branchBillingState(b, sub(50), at(23)).state).toBe('closed');
  });

  it('a store the owner stopped renewing closes when its paid time runs out', () => {
    const b = opened({paidUntil: at(20), renew: false});
    expect(branchBillingState(b, sub(20), at(10)).state).toBe('paid');
    expect(branchBillingState(b, sub(50), at(20.5)).state).toBe('closed');
    // And with no warning days after its free days either.
    expect(branchBillingState(opened({renew: false}), sub(20), at(3.1)).state).toBe('closed');
  });
});

describe('fitRenewal', () => {
  // Plan 299 000 + 150 000 per extra store.
  const totalFor = (k: number) => 299_000 + k * 150_000;
  const yearTotal = (m: number) => m * 12 * 0.8;

  it('renews nothing when the plan alone is not covered', () => {
    expect(
      fitRenewal({balance: 200_000, candidates: 2, totalFor, cycleWanted: 'month', yearTotal}),
    ).toEqual({renews: false});
  });

  it('takes as many stores as fit, oldest first', () => {
    expect(
      fitRenewal({balance: 500_000, candidates: 3, totalFor, cycleWanted: 'month', yearTotal}),
    ).toEqual({renews: true, stores: 1, cycle: 'month'});
    expect(
      fitRenewal({balance: 299_000, candidates: 3, totalFor, cycleWanted: 'month', yearTotal}),
    ).toEqual({renews: true, stores: 0, cycle: 'month'});
    expect(
      fitRenewal({balance: 9_000_000, candidates: 3, totalFor, cycleWanted: 'month', yearTotal}),
    ).toEqual({renews: true, stores: 3, cycle: 'month'});
  });

  it('a wanted year needs the year for every renewing store, else a month', () => {
    const all = yearTotal(totalFor(2));
    expect(
      fitRenewal({balance: all, candidates: 2, totalFor, cycleWanted: 'year', yearTotal}),
    ).toEqual({renews: true, stores: 2, cycle: 'year'});
    expect(
      fitRenewal({balance: all - 1, candidates: 2, totalFor, cycleWanted: 'year', yearTotal}),
    ).toEqual({renews: true, stores: 2, cycle: 'month'});
  });
});
