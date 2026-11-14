import {
  addCalendarMonth,
  classifyPlanChange,
  computeBillingStage,
  AI_ADDON_PRICE,
  computeMonthlyTotal,
  graceEndsAt,
  isRestricted,
  nextPeriod,
  normalizeDiscountInput,
  periodDays,
  prorate,
  round1000,
  tashkentDaysBetween,
  tashkentHour,
  type DiscountTerm,
} from './billing';

// Tashkent is UTC+5: 19:00Z is already the next local day.
const at = (iso: string) => new Date(iso);

describe('tashkentDaysBetween', () => {
  it('counts Tashkent calendar days, not 24h blocks', () => {
    // 23:00 local on the 10th → 01:00 local on the 11th: one day apart.
    expect(
      tashkentDaysBetween(
        at('2026-11-10T18:00:00Z'),
        at('2026-11-10T20:00:00Z'),
      ),
    ).toBe(1);
    // Same local day, hours apart.
    expect(
      tashkentDaysBetween(
        at('2026-11-10T00:00:00Z'),
        at('2026-11-10T18:00:00Z'),
      ),
    ).toBe(0);
  });

  it('goes negative for a date in the past and accepts ISO strings', () => {
    expect(
      tashkentDaysBetween('2026-11-10T07:00:00Z', '2026-11-07T07:00:00Z'),
    ).toBe(-3);
  });
});

describe('computeBillingStage', () => {
  const now = at('2026-11-10T07:00:00Z'); // 12:00 Tashkent
  const base = {balance: 0, amountNeeded: 299_000, now};

  it('is none for an open-ended subscription', () => {
    expect(computeBillingStage({...base, endDate: null})).toBe('none');
  });

  it('is none more than 7 days out, or when the balance covers the renewal', () => {
    expect(
      computeBillingStage({...base, endDate: at('2026-11-18T07:00:00Z')}),
    ).toBe('none');
    expect(
      computeBillingStage({
        ...base,
        balance: 299_000,
        endDate: at('2026-11-12T07:00:00Z'),
      }),
    ).toBe('none');
  });

  it('reminds from 7 to 4 days and turns urgent from 3 down to today', () => {
    expect(
      computeBillingStage({...base, endDate: at('2026-11-17T07:00:00Z')}),
    ).toBe('reminder');
    expect(
      computeBillingStage({...base, endDate: at('2026-11-14T07:00:00Z')}),
    ).toBe('reminder');
    expect(
      computeBillingStage({...base, endDate: at('2026-11-13T07:00:00Z')}),
    ).toBe('urgent');
    expect(
      computeBillingStage({...base, endDate: at('2026-11-10T18:00:00Z')}),
    ).toBe('urgent');
  });

  it('is grace for 3 days after end_date, then restricted regardless of balance', () => {
    expect(
      computeBillingStage({...base, endDate: at('2026-11-10T06:00:00Z')}),
    ).toBe('grace');
    expect(
      computeBillingStage({...base, endDate: at('2026-11-07T07:00:01Z')}),
    ).toBe('grace');
    expect(
      computeBillingStage({...base, endDate: at('2026-11-07T07:00:00Z')}),
    ).toBe('restricted');
    expect(
      computeBillingStage({
        ...base,
        balance: 10_000_000,
        endDate: at('2026-11-01T00:00:00Z'),
      }),
    ).toBe('restricted');
  });

  it('shows nothing in grace when the balance already covers the renewal', () => {
    expect(
      computeBillingStage({
        ...base,
        balance: 300_000,
        endDate: at('2026-11-09T00:00:00Z'),
      }),
    ).toBe('none');
  });
});

describe('grace helpers', () => {
  it('restricts exactly 3 days after end_date', () => {
    const end = at('2026-11-01T10:00:00Z');
    expect(graceEndsAt(end).toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(isRestricted(end, at('2026-11-04T09:59:59Z'))).toBe(false);
    expect(isRestricted(end, at('2026-11-04T10:00:00Z'))).toBe(true);
    expect(isRestricted(null, at('2030-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('computeMonthlyTotal', () => {
  const now = at('2026-11-10T00:00:00Z');
  const d = (id: string, term: Partial<DiscountTerm>): DiscountTerm => ({
    id,
    label: id,
    percent: 0,
    validUntil: null,
    ...term,
  });
  const lines = (m: {discountLines: {id: string | null; amount: number}[]}) =>
    m.discountLines.map((l) => [l.id, l.amount]);

  it('adds 150 000 per extra branch and charges the list price without discounts', () => {
    expect(
      computeMonthlyTotal({planPrice: 299_000, planTier: 'pro', extraBranches: 2}),
    ).toEqual({
      planPrice: 299_000,
      extraBranches: 2,
      extraBranchesTotal: 300_000,
      aiAddon: 0,
      subtotal: 599_000,
      discountPercent: 0,
      discountAmount: 0,
      discountLines: [],
      total: 599_000,
    });
  });

  it('adds the AI add-on at list price; plan discounts never reach it', () => {
    const m = computeMonthlyTotal({
      planPrice: 199_000,
      planTier: 'online',
      extraBranches: 0,
      aiAddon: true,
      discounts: [
        d('half', {percent: 50, scope: 'all'}),
        d('lock', {kind: 'price', scope: 'plan', amount: 150_000}),
      ],
      now,
    });
    expect(m.aiAddon).toBe(AI_ADDON_PRICE);
    expect(m.subtotal).toBe(199_000 + AI_ADDON_PRICE);
    // 150 000 locked price, half off it, then the add-on in full.
    expect(m.total).toBe(75_000 + AI_ADDON_PRICE);
    expect(m.discountAmount).toBe(m.subtotal - m.total);
  });

  it('lets a fixed amount eat into the add-on as part of the month', () => {
    const m = computeMonthlyTotal({
      planPrice: 199_000,
      planTier: 'online',
      extraBranches: 0,
      aiAddon: true,
      discounts: [d('gift', {kind: 'amount', scope: 'all', amount: 300_000})],
      now,
    });
    expect(m.total).toBe(199_000 + AI_ADDON_PRICE - 300_000);
  });

  it('reads a row from before kinds existed as a percent off the plan only', () => {
    expect(
      computeMonthlyTotal({
        planPrice: 299_000,
        planTier: 'pro',
        extraBranches: 2,
        // No kind, no scope: what every pre-0104 row (and cache entry) is.
        discounts: [{id: 'a', label: '10%', percent: 10, validUntil: null}],
        now,
      }),
    ).toEqual({
      planPrice: 299_000,
      extraBranches: 2,
      extraBranchesTotal: 300_000,
      aiAddon: 0,
      subtotal: 599_000,
      discountPercent: 10,
      discountAmount: 29_900,
      discountLines: [{id: 'a', label: '10%', kind: 'percent', amount: 29_900}],
      total: 569_100,
    });
  });

  it('ignores expired discounts and adds the percents up', () => {
    const m = computeMonthlyTotal({
      planPrice: 200_000,
      planTier: 'pro',
      extraBranches: 0,
      discounts: [
        d('open', {percent: 10}),
        d('expired', {percent: 20, validUntil: '2026-11-09T00:00:00Z'}),
        d('future', {percent: 15, validUntil: at('2026-12-01T00:00:00Z')}),
      ],
      now,
    });
    expect(m.discountPercent).toBe(25);
    expect(m.total).toBe(150_000);
    expect(lines(m)).toEqual([
      ['open', 20_000],
      ['future', 30_000],
    ]);
  });

  it('caps the percents at 100 and still charges the branches', () => {
    const m = computeMonthlyTotal({
      planPrice: 119_000,
      planTier: 'basic',
      extraBranches: 1,
      discounts: [d('a', {percent: 70}), d('b', {percent: 60})],
      now,
    });
    expect(m.discountPercent).toBe(100);
    expect(m.total).toBe(150_000);
    // 119 000 split 70:60, the last line takes the rounding.
    expect(lines(m)).toEqual([
      ['a', 64_077],
      ['b', 54_923],
    ]);
  });

  it('takes a percent off the branches, or off both, by its scope', () => {
    const m = computeMonthlyTotal({
      planPrice: 299_000,
      planTier: 'pro',
      extraBranches: 2,
      discounts: [
        d('all', {percent: 10, scope: 'all'}),
        d('branches', {percent: 20, scope: 'branches'}),
      ],
      now,
    });
    // Plan: 10% of 299 000. Branches: 30% of 300 000, split 10:20.
    expect(m.discountPercent).toBe(10);
    expect(lines(m)).toEqual([
      ['all', 29_900 + 30_000],
      ['branches', 60_000],
    ]);
    expect(m.total).toBe(599_000 - 119_900);
  });

  it('replaces the plan price with a special price, only on the plan it was agreed for', () => {
    const lock = d('old-price', {
      kind: 'price',
      scope: 'plan',
      amount: 399_000,
      planTier: 'proplus',
    });
    const onPlus = computeMonthlyTotal({
      planPrice: 499_000,
      planTier: 'proplus',
      extraBranches: 0,
      discounts: [lock],
      now,
    });
    expect(onPlus.total).toBe(399_000);
    expect(onPlus.discountPercent).toBe(0);
    expect(lines(onPlus)).toEqual([['old-price', 100_000]]);

    // The shop moves down to Business: the Business+ price does not follow.
    const onBusiness = computeMonthlyTotal({
      planPrice: 299_000,
      planTier: 'pro',
      extraBranches: 0,
      discounts: [lock],
      now,
    });
    expect(onBusiness.total).toBe(299_000);
    expect(onBusiness.discountLines).toEqual([]);
  });

  it('never raises a price, and the lowest special price wins', () => {
    const above = computeMonthlyTotal({
      planPrice: 299_000,
      planTier: 'pro',
      extraBranches: 0,
      discounts: [d('above', {kind: 'price', amount: 399_000})],
      now,
    });
    expect(above.total).toBe(299_000);
    expect(above.discountLines).toEqual([]);

    const two = computeMonthlyTotal({
      planPrice: 499_000,
      planTier: 'proplus',
      extraBranches: 0,
      discounts: [
        d('a', {kind: 'price', amount: 399_000}),
        d('b', {kind: 'price', amount: 349_000}),
      ],
      now,
    });
    expect(two.total).toBe(349_000);
    expect(lines(two)).toEqual([['b', 150_000]]);
  });

  it('combines in one order: price, then percents, then fixed sums', () => {
    const m = computeMonthlyTotal({
      planPrice: 499_000,
      planTier: 'proplus',
      extraBranches: 2,
      // Given in a different order on purpose.
      discounts: [
        d('sum', {kind: 'amount', scope: 'all', amount: 50_000}),
        d('pct', {percent: 10}),
        d('branch-price', {kind: 'price', scope: 'branches', amount: 100_000}),
        d('plan-price', {kind: 'price', scope: 'plan', amount: 399_000}),
      ],
      now,
    });
    // Plan 499 → 399, −10% = 359 100. Branches 2 × 100 000. Then −50 000.
    expect(m.subtotal).toBe(799_000);
    expect(m.total).toBe(509_100);
    expect(m.discountAmount).toBe(289_900);
    // Listed as applied, not as given.
    expect(lines(m)).toEqual([
      ['branch-price', 100_000],
      ['plan-price', 100_000],
      ['pct', 39_900],
      ['sum', 50_000],
    ]);
  });

  it('never goes below zero on a fixed sum', () => {
    const m = computeMonthlyTotal({
      planPrice: 119_000,
      planTier: 'basic',
      extraBranches: 0,
      discounts: [d('big', {kind: 'amount', amount: 200_000})],
      now,
    });
    expect(m.total).toBe(0);
    expect(lines(m)).toEqual([['big', 119_000]]);
  });
});

describe('normalizeDiscountInput', () => {
  it('defaults to a percent off the plan', () => {
    expect(normalizeDiscountInput({percent: 10}, 'pro')).toEqual({
      kind: 'percent',
      scope: 'plan',
      percent: 10,
      amount: null,
      planTier: null,
      validUntil: null,
    });
    expect(normalizeDiscountInput({percent: 0}, 'pro')).toEqual({error: 'percent'});
    expect(normalizeDiscountInput({percent: 101}, 'pro')).toEqual({error: 'percent'});
    expect(normalizeDiscountInput({kind: 'gift', percent: 5}, 'pro')).toEqual({
      error: 'kind',
    });
  });

  it('takes a fixed sum off the whole month whatever scope was sent', () => {
    expect(
      normalizeDiscountInput({kind: 'amount', scope: 'plan', amount: 50_000}, 'pro'),
    ).toMatchObject({kind: 'amount', scope: 'all', percent: 0, amount: 50_000});
    expect(normalizeDiscountInput({kind: 'amount'}, 'pro')).toEqual({
      error: 'amount',
    });
  });

  it('ties a special plan price to a plan tier', () => {
    expect(
      normalizeDiscountInput({kind: 'price', amount: 399_000}, 'proplus'),
    ).toMatchObject({kind: 'price', scope: 'plan', amount: 399_000, planTier: 'proplus'});
    // The request may name another plan than the current one.
    expect(
      normalizeDiscountInput({kind: 'price', amount: 249_000, planTier: 'pro'}, 'proplus'),
    ).toMatchObject({planTier: 'pro'});
    // No subscription and no tier named: nothing to tie it to.
    expect(normalizeDiscountInput({kind: 'price', amount: 399_000}, null)).toEqual({
      error: 'planTier',
    });
    // A per-branch price needs no plan; "all" is not a price.
    expect(
      normalizeDiscountInput({kind: 'price', scope: 'branches', amount: 100_000}, null),
    ).toMatchObject({scope: 'branches', planTier: null});
    expect(
      normalizeDiscountInput({kind: 'price', scope: 'all', amount: 1}, 'pro'),
    ).toEqual({error: 'scope'});
  });

  it('parses the expiry and rejects a bad date', () => {
    expect(
      normalizeDiscountInput({percent: 10, validUntil: '2027-02-01T00:00:00.000Z'}, 'pro'),
    ).toMatchObject({validUntil: at('2027-02-01T00:00:00.000Z')});
    expect(normalizeDiscountInput({percent: 10, validUntil: 'soon'}, 'pro')).toEqual({
      error: 'validUntil',
    });
  });
});

describe('prorate', () => {
  it('charges the remaining share of the month, to the nearest 1 000', () => {
    // (399 000 − 299 000) × 12 / 30 = 40 000
    expect(
      prorate({
        monthlyAmount: 100_000,
        discountPercent: 0,
        daysRemaining: 12,
        periodDays: 30,
      }),
    ).toBe(40_000);
    // 150 000 × 7 / 31 = 33 870.97 → 34 000
    expect(
      prorate({
        monthlyAmount: 150_000,
        discountPercent: 0,
        daysRemaining: 7,
        periodDays: 31,
      }),
    ).toBe(34_000);
  });

  it('applies the discount and never goes negative or past the full month', () => {
    // 150 000 × 0.8 × 10 / 30 = 40 000
    expect(
      prorate({
        monthlyAmount: 150_000,
        discountPercent: 20,
        daysRemaining: 10,
        periodDays: 30,
      }),
    ).toBe(40_000);
    expect(
      prorate({
        monthlyAmount: 150_000,
        discountPercent: 0,
        daysRemaining: -2,
        periodDays: 30,
      }),
    ).toBe(0);
    expect(
      prorate({
        monthlyAmount: 150_000,
        discountPercent: 0,
        daysRemaining: 45,
        periodDays: 30,
      }),
    ).toBe(150_000);
  });

  it('rounds half up to the next 1 000', () => {
    expect(round1000(1_499)).toBe(1_000);
    expect(round1000(1_500)).toBe(2_000);
  });
});

describe('periodDays', () => {
  it('measures the period and what is left of it in Tashkent days', () => {
    expect(
      periodDays(
        at('2026-11-01T07:00:00Z'),
        at('2026-12-01T07:00:00Z'),
        at('2026-11-19T15:00:00Z'),
      ),
    ).toEqual({daysRemaining: 12, periodDays: 30});
  });
});

describe('addCalendarMonth', () => {
  it('keeps the Tashkent wall-clock time and moves one calendar month', () => {
    expect(addCalendarMonth(at('2026-11-10T07:30:00Z')).toISOString()).toBe(
      '2026-12-10T07:30:00.000Z',
    );
    // Rolls into the next year.
    expect(addCalendarMonth(at('2026-12-15T07:00:00Z')).toISOString()).toBe(
      '2027-01-15T07:00:00.000Z',
    );
  });

  it('clamps the day to the end of a shorter month', () => {
    // 31 Jan 10:00 Tashkent → 28 Feb 10:00 Tashkent (2027 is not a leap year).
    expect(addCalendarMonth(at('2027-01-31T05:00:00Z')).toISOString()).toBe(
      '2027-02-28T05:00:00.000Z',
    );
    // Leap year.
    expect(addCalendarMonth(at('2028-01-31T05:00:00Z')).toISOString()).toBe(
      '2028-02-29T05:00:00.000Z',
    );
  });

  it('uses the Tashkent day, not the UTC one', () => {
    // 31 Mar 22:00Z is already 1 Apr 03:00 in Tashkent → 1 May 03:00 Tashkent.
    expect(addCalendarMonth(at('2027-03-31T22:00:00Z')).toISOString()).toBe(
      '2027-04-30T22:00:00.000Z',
    );
  });
});

describe('nextPeriod', () => {
  const oldEnd = at('2026-11-10T07:00:00Z');

  it('continues from the old end date when paid within grace', () => {
    const p = nextPeriod(oldEnd, at('2026-11-12T07:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-11-10T07:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-12-10T07:00:00.000Z');
  });

  it('starts from now when paid after the plan was restricted', () => {
    const now = at('2026-11-20T09:15:00Z');
    const p = nextPeriod(oldEnd, now);
    expect(p.start).toBe(now);
    expect(p.end.toISOString()).toBe('2026-12-20T09:15:00.000Z');
  });
});

describe('classifyPlanChange', () => {
  const now = at('2026-11-10T07:00:00Z');
  const pro = {tier: 'pro', price: 299_000};
  const basic = {tier: 'basic', price: 119_000};
  const proplus = {tier: 'proplus', price: 399_000};
  const dated = {
    planTier: 'pro',
    planPrice: 299_000,
    endDate: at('2026-11-25T07:00:00Z'),
    isTrial: false,
  };

  it('creates a fresh dated row without a subscription or on the open-ended free floor', () => {
    expect(classifyPlanChange({current: null, target: pro, now})).toEqual({
      kind: 'fresh',
      direction: 'upgrade',
    });
    expect(
      classifyPlanChange({
        current: {
          planTier: 'free',
          planPrice: 0,
          endDate: null,
          isTrial: false,
        },
        target: pro,
        now,
      }).kind,
    ).toBe('fresh');
  });

  it('refuses an open-ended paid plan', () => {
    expect(
      classifyPlanChange({
        current: {...dated, endDate: null},
        target: basic,
        now,
      }).kind,
    ).toBe('managed');
  });

  it('swaps for free once past end_date, even inside grace', () => {
    expect(
      classifyPlanChange({
        current: {...dated, endDate: at('2026-11-09T07:00:00Z')},
        target: proplus,
        now,
      }).kind,
    ).toBe('expired');
  });

  it('is free and immediate during the trial in either direction', () => {
    expect(
      classifyPlanChange({
        current: {...dated, isTrial: true},
        target: basic,
        now,
      }),
    ).toEqual({
      kind: 'trial',
      direction: 'downgrade',
    });
  });

  it('decides up/down by price while a paid period runs', () => {
    expect(
      classifyPlanChange({current: dated, target: proplus, now}).kind,
    ).toBe('upgrade');
    expect(classifyPlanChange({current: dated, target: basic, now}).kind).toBe(
      'downgrade',
    );
    expect(classifyPlanChange({current: dated, target: pro, now}).kind).toBe(
      'same',
    );
    // Another plan at the same price is not cheaper → immediate, nothing to charge.
    expect(
      classifyPlanChange({
        current: dated,
        target: {tier: 'x', price: 299_000},
        now,
      }).kind,
    ).toBe('upgrade');
  });
});

describe('tashkentHour', () => {
  it('reads the hour on the Tashkent clock', () => {
    expect(tashkentHour(at('2026-11-10T03:00:00Z'))).toBe(8);
    expect(tashkentHour(at('2026-11-10T19:30:00Z'))).toBe(0);
  });
});
