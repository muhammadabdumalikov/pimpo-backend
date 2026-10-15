import {
  AI_IMAGE_DEFAULT_LIMIT_USD,
  allowanceUsd,
  crossedBudgetThreshold,
  imageCallCostUsd,
  periodEnd,
  periodOf,
  periodStart,
  typicalImageCostUsd,
  usageView,
} from './ai-image.pricing';

describe('AI image pricing', () => {
  it('prices a 1K Nano Banana 2.1 image at the published $0.0336', () => {
    const cost = imageCallCostUsd('gemini-nano-banana-2.1', {
      inputTokens: 0,
      imageTokens: 1120,
      textTokens: 0,
    });
    expect(cost).toBeCloseTo(0.0336, 6);
  });

  it('prices Pro at $0.134 per 1K image', () => {
    const cost = imageCallCostUsd('gemini-3-pro-image', {
      inputTokens: 0,
      imageTokens: 1120,
      textTokens: 0,
    });
    expect(cost).toBeCloseTo(0.1344, 4);
  });

  it('adds input and thinking tokens', () => {
    const cost = imageCallCostUsd('gemini-nano-banana-2.1', {
      inputTokens: 1000,
      imageTokens: 1120,
      textTokens: 2000,
    });
    // 1000×1.5/M + 1120×30/M + 2000×7.5/M
    expect(cost).toBeCloseTo(0.0015 + 0.0336 + 0.015, 6);
  });

  it('charges an unknown model the dearest price, never zero', () => {
    const cost = imageCallCostUsd('gemini-some-future-image', {
      inputTokens: 10,
      imageTokens: 1120,
      textTokens: 0,
    });
    expect(cost).toBeGreaterThanOrEqual(0.134);
    // …but a refusal that drew nothing is free, like Google bills it.
    expect(
      imageCallCostUsd('gemini-some-future-image', {
        inputTokens: 10,
        imageTokens: 0,
        textTokens: 0,
      }),
    ).toBe(0);
  });

  it('expects ~$0.05 per picture on 2.1, so $15 is a few hundred images', () => {
    const typical = typicalImageCostUsd('gemini-nano-banana-2.1');
    expect(typical).toBeGreaterThan(0.034);
    expect(typical).toBeLessThan(0.06);
    expect(Math.floor(15 / typical)).toBeGreaterThan(250);
  });
});

describe('AI image calendar (+05:00)', () => {
  it('rolls the month over at midnight Tashkent, not UTC', () => {
    // 2026-10-31 19:30 UTC is already 2026-11-01 00:30 in Tashkent.
    expect(periodOf(new Date('2026-10-31T19:30:00Z'))).toBe('2026-11');
    expect(periodOf(new Date('2026-10-31T18:59:59Z'))).toBe('2026-10');
  });

  it('bounds a period by Tashkent midnights', () => {
    expect(periodStart('2026-10').toISOString()).toBe(
      '2026-09-30T19:00:00.000Z',
    );
    expect(periodEnd('2026-10').toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect(periodEnd('2026-12').toISOString()).toBe('2026-12-31T19:00:00.000Z');
  });
});

describe('AI image allowance', () => {
  it('defaults to $15 with no quota row', () => {
    expect(allowanceUsd(null, '2026-10')).toBe(AI_IMAGE_DEFAULT_LIMIT_USD);
    expect(AI_IMAGE_DEFAULT_LIMIT_USD).toBe(15);
  });

  it('uses the override and adds a bonus only in its month', () => {
    const quota = {monthlyLimitUsd: 40, bonusUsd: 10, bonusPeriod: '2026-10'};
    expect(allowanceUsd(quota, '2026-10')).toBe(50);
    expect(allowanceUsd(quota, '2026-11')).toBe(40);
  });

  it('keeps the default when only a bonus was granted', () => {
    const quota = {monthlyLimitUsd: null, bonusUsd: 5, bonusPeriod: '2026-10'};
    expect(allowanceUsd(quota, '2026-10')).toBe(20);
  });

  it('shows percent and images left, never dollars', () => {
    const view = usageView(3, 15, 'gemini-nano-banana-2.1', '2026-10');
    expect(view.percentUsed).toBe(20);
    expect(view.exhausted).toBe(false);
    expect(view.resetsAt).toBe('2026-10-31T19:00:00.000Z');
    expect(view.approxImagesLeft).toBeGreaterThan(200);
    expect(Object.keys(view)).not.toContain('spentUsd');
  });

  it('is exhausted at the allowance, with nothing left', () => {
    const view = usageView(15.01, 15, 'gemini-nano-banana-2.1', '2026-10');
    expect(view.exhausted).toBe(true);
    expect(view.percentUsed).toBe(100);
    expect(view.approxImagesLeft).toBe(0);
  });

  it('never rounds up to 100% before the allowance is spent', () => {
    const view = usageView(14.99, 15, 'gemini-nano-banana-2.1', '2026-10');
    expect(view.percentUsed).toBe(99);
    expect(view.exhausted).toBe(false);
  });

  it('treats a zero allowance as exhausted', () => {
    expect(usageView(0, 0, 'gemini-nano-banana-2.1', '2026-10').exhausted).toBe(
      true,
    );
  });
});

describe('platform budget alert', () => {
  it('fires once at 80% and once at 100%', () => {
    expect(crossedBudgetThreshold(79, 81, 100)).toBe(80);
    expect(crossedBudgetThreshold(81, 85, 100)).toBeNull();
    expect(crossedBudgetThreshold(99, 100, 100)).toBe(100);
    expect(crossedBudgetThreshold(100, 101, 100)).toBeNull();
  });

  it('reports only the higher threshold when one call crosses both', () => {
    expect(crossedBudgetThreshold(70, 120, 100)).toBe(100);
  });
});
