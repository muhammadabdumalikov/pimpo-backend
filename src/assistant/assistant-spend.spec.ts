import {PROVIDER_MODELS} from '../ai/providers/llm-provider.interface';
import {botSpend, botSummary, listCostUsd, type BotSpendGroup} from './assistant-spend';

const MODEL = PROVIDER_MODELS.gemini[0].id;
const opts = {usdRate: 12_000, provider: 'gemini' as const};
const group = (g: Partial<BotSpendGroup>): BotSpendGroup => ({
  businessId: 'a',
  model: MODEL,
  paid: false,
  runs: 1,
  tokensIn: 3_000,
  tokensOut: 150,
  chargedUzs: 0,
  ...g,
});

describe('listCostUsd', () => {
  it("prices a model at its own provider's list price, no margin", () => {
    expect(listCostUsd(MODEL, 3_000, 150, 'gemini')).toBeCloseTo(0.000975, 9);
    // The bot ran on another provider then: still that model's price.
    expect(listCostUsd('gpt-5.2', 1_000_000, 0, 'gemini')).toBeCloseTo(1.75, 9);
  });

  it("prices a failed run (no model) or an unlisted one as the provider's default", () => {
    const def = listCostUsd(MODEL, 3_000, 150, 'gemini');
    expect(listCostUsd(null, 3_000, 150, 'gemini')).toBe(def);
    expect(listCostUsd('gemini-unknown', 3_000, 150, 'gemini')).toBe(def);
  });
});

describe('botSpend', () => {
  const groups = [
    // Two paid answers, charged 15.21 each (list × 1.3 at 12 000).
    group({paid: true, runs: 2, tokensIn: 6_000, tokensOut: 300, chargedUzs: 30.42}),
    // Three free ones, a failed run, an answer on an unlisted model.
    group({runs: 3, tokensIn: 9_000, tokensOut: 450}),
    group({model: null}),
    group({model: 'gemini-unknown'}),
  ];

  it('counts every run that used tokens, paid or not', () => {
    const s = botSpend(groups, opts);
    expect(s.answerCount).toBe(7);
    expect(s.paidAnswerCount).toBe(2);
    expect(s.freeAnswerCount).toBe(5);
    expect(s.chargedUzs).toBe(30.42);
  });

  it('costs a paid run at what it was charged less the margin, an unpaid one at the rate', () => {
    const s = botSpend(groups, opts);
    expect(s.costUsd).toBeCloseTo(0.006825, 6);
    // Unpaid: (0.002925 + 0.000975 + 0.000975) $ × 12 000.
    expect(s.freeCostUzs).toBe(58.5);
    // Paid: 30.42 / 1.3 = 23.40, whatever today's rate.
    expect(s.costUzs).toBe(81.9);
    expect(s.marginUzs).toBe(-51.48);
    // Another rate moves only the unpaid part.
    const later = botSpend(groups, {...opts, usdRate: 14_400});
    expect(later.freeCostUzs).toBe(70.2);
    expect(later.costUzs).toBe(93.6);
  });

  it('keeps the margin exactly charged − cost after rounding', () => {
    const odd = [
      group({paid: true, runs: 3, chargedUzs: 45.63}),
      group({runs: 7, tokensIn: 21_007, tokensOut: 1_049}),
    ];
    const s = botSpend(odd, {usdRate: 12_345.67, provider: 'gemini'});
    expect(s.marginUzs).toBe(round2(s.chargedUzs - s.costUzs));
    expect(s.freeCostUzs).toBeLessThanOrEqual(s.costUzs);
    expect(s.paidAnswerCount + s.freeAnswerCount).toBe(s.answerCount);
  });

  it('is all zeros with no runs', () => {
    expect(botSpend([], opts)).toEqual({
      answerCount: 0,
      paidAnswerCount: 0,
      freeAnswerCount: 0,
      chargedUzs: 0,
      costUsd: 0,
      costUzs: 0,
      freeCostUzs: 0,
      marginUzs: 0,
    });
  });
});

describe('botSummary', () => {
  it('adds the shops up and lists the busiest first, at most `top`', () => {
    const groups = [
      group({businessId: 'a', name: 'Zara', runs: 2}),
      group({businessId: 'a', name: 'Zara', paid: true, runs: 1, chargedUzs: 15.21}),
      group({businessId: 'b', name: 'Bek', runs: 5}),
      group({businessId: 'c', name: 'Cafe', runs: 1}),
    ];
    const s = botSummary(groups, {...opts, model: MODEL, top: 2});
    expect(s.model).toBe(MODEL);
    expect(s.usdRate).toBe(12_000);
    expect(s.answerCount).toBe(9);
    expect(s.topBusinesses.map((b) => b.businessId)).toEqual(['b', 'a']);
    const a = s.topBusinesses[1];
    expect(a).toEqual({
      businessId: 'a',
      name: 'Zara',
      answerCount: 3,
      chargedUzs: 15.21,
      costUzs: botSpend(groups.slice(0, 2), opts).costUzs,
      marginUzs: botSpend(groups.slice(0, 2), opts).marginUzs,
    });
  });
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
