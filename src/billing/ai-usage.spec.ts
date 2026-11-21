import {PROVIDER_MODELS} from '../ai/providers/llm-provider.interface';
import {
  PLAN_FREE_ANSWERS,
  TRIAL_FREE_ANSWERS,
  answerCharge,
  botFunds,
  freeAllowance,
  renewalMonthlyTotal,
  renewalReserve,
  settlement,
  spendable,
  typicalAnswerCharge,
} from './ai-usage';
import {cycleTotal} from './billing';

const MODEL = PROVIDER_MODELS.gemini[0];
const PRICE = MODEL.usdPer1M!;
const RATE = 12_000;

describe('freeAllowance', () => {
  it('gives Business+ its answers every month, trial or not', () => {
    expect(freeAllowance({planTier: 'proplus', isTrial: false})).toEqual({
      kind: 'monthly',
      limit: PLAN_FREE_ANSWERS,
    });
    expect(
      freeAllowance({planTier: 'proplus', isTrial: true, monthlyLimit: 300}),
    ).toEqual({kind: 'monthly', limit: 300});
  });

  it('gives the online seller plan 500 answers on its trial only', () => {
    expect(freeAllowance({planTier: 'online', isTrial: true})).toEqual({
      kind: 'trial',
      limit: TRIAL_FREE_ANSWERS,
    });
    expect(freeAllowance({planTier: 'online', isTrial: false})).toBeNull();
  });

  it('gives nothing to a plan without the bot', () => {
    expect(freeAllowance({planTier: 'pro', isTrial: true})).toBeNull();
    expect(freeAllowance({planTier: null, isTrial: false})).toBeNull();
  });
});

describe('answerCharge', () => {
  const charge = (tokensIn: number, tokensOut: number, model = MODEL.id) =>
    answerCharge({
      provider: 'gemini',
      model,
      tokensIn,
      tokensOut,
      usdRate: RATE,
    });

  it("is the tokens at list price plus 30%, in so'm", () => {
    const usd = (3_000 * PRICE.input) / 1e6 + (150 * PRICE.output) / 1e6;
    expect(charge(3_000, 150)).toBeCloseTo(usd * 1.3 * RATE, 2);
    expect(typicalAnswerCharge('gemini', MODEL.id, RATE)).toBe(
      charge(3_000, 150),
    );
  });

  it('costs nothing when no tokens were used', () => {
    expect(charge(0, 0)).toBe(0);
  });

  it('bills a model missing from the price table as the default one', () => {
    expect(charge(3_000, 150, 'gemini-some-new-model')).toBe(
      charge(3_000, 150),
    );
  });

  it('follows the rate', () => {
    const at = (usdRate: number) =>
      answerCharge({
        provider: 'gemini',
        model: MODEL.id,
        tokensIn: 1_000_000,
        tokensOut: 0,
        usdRate,
      });
    expect(at(13_000) / at(10_000)).toBeCloseTo(1.3, 6);
  });
});

describe('botFunds', () => {
  const none = {balance: 0, unsettled: 0, reserve: 0};

  it('is free while free answers are left, whatever the balance', () => {
    expect(botFunds({free: {limit: 500, used: 499}, ...none})).toBe('free');
  });

  it('is paid once they are used up and the balance covers more than the next month', () => {
    expect(
      botFunds({
        free: {limit: 500, used: 500},
        balance: 260_000,
        unsettled: 0,
        reserve: 249_000,
      }),
    ).toBe('paid');
  });

  it('never spends the next month of the subscription', () => {
    expect(
      botFunds({free: null, balance: 249_000, unsettled: 0, reserve: 249_000}),
    ).toBe('blocked');
  });

  it('counts answers not yet settled as already spent', () => {
    const funds = {balance: 250_000, unsettled: 1_000, reserve: 249_000};
    expect(spendable(funds)).toBe(0);
    expect(botFunds({free: null, ...funds})).toBe('blocked');
  });

  it('holds nothing back on a subscription that is never billed', () => {
    expect(botFunds({free: null, balance: 500, unsettled: 0, reserve: 0})).toBe(
      'paid',
    );
    expect(botFunds({free: null, ...none})).toBe('blocked');
  });
});

describe('renewalReserve', () => {
  const now = new Date('2026-11-21T07:00:00Z');
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
  const month = {monthlyTotal: 249_000, cycleWanted: 'month' as const, now};
  const year = cycleTotal(249_000, 'year');
  const yearly = {...month, cycleWanted: 'year' as const};

  it('holds nothing while the renewal is more than a week away', () => {
    expect(
      renewalReserve({...month, endDate: inDays(20), balance: 300_000}),
    ).toBe(0);
    expect(
      renewalReserve({...yearly, endDate: inDays(20), balance: year + 10}),
    ).toBe(0);
  });

  it('holds the next month from the first reminder until the renewal', () => {
    expect(
      renewalReserve({...month, endDate: inDays(7), balance: 300_000}),
    ).toBe(249_000);
    // Past the end, in the grace days: still waiting for the renewal.
    expect(
      renewalReserve({...month, endDate: inDays(-2), balance: 300_000}),
    ).toBe(249_000);
    // A monthly shop with a year's money still holds only a month.
    expect(
      renewalReserve({...month, endDate: inDays(3), balance: year + 10}),
    ).toBe(249_000);
  });

  it('holds the whole year when a year is wanted and the balance covers it', () => {
    expect(year).toBe(2_390_000);
    expect(renewalReserve({...yearly, endDate: inDays(3), balance: year})).toBe(
      year,
    );
    expect(
      renewalReserve({...yearly, endDate: inDays(-1), balance: year + 10}),
    ).toBe(year);
  });

  it('holds a month when the balance is short of the year (the renewal falls back)', () => {
    expect(
      renewalReserve({...yearly, endDate: inDays(3), balance: year - 1}),
    ).toBe(249_000);
  });

  it("keeps the year's money whole through the last answer's overshoot", () => {
    // 10 so'm spendable above the year, the answer cost 15.21: measured on
    // the balance as it stands, the reserve stays the year…
    const balance = year + 10;
    const reserve = renewalReserve({...yearly, endDate: inDays(3), balance});
    expect(reserve).toBe(year);
    expect(botFunds({free: null, balance, unsettled: 15.21, reserve})).toBe(
      'blocked',
    );
    // …so the settlement leaves exactly the year.
    const take = settlement({unsettled: 15.21, answers: 1, balance, reserve});
    expect(balance - take.amount).toBe(year);
  });

  it('holds nothing on a subscription that is never billed', () => {
    expect(
      renewalReserve({...yearly, endDate: null, balance: year * 2}),
    ).toBe(0);
  });
});

describe('renewalMonthlyTotal', () => {
  const pro = {price: '299000', tier: 'pro'};
  const proplus = {price: '499000', tier: 'proplus'};

  it('prices the plan the renewal charges: a scheduled downgrade', () => {
    expect(
      renewalMonthlyTotal({plan: proplus, extraBranches: 0, discounts: []}),
    ).toBe(499_000);
    expect(
      renewalMonthlyTotal({
        plan: proplus,
        pendingPlan: pro,
        extraBranches: 1,
        discounts: [],
      }),
    ).toBe(299_000 + 150_000);
  });

  it("drops a discount tied to the plan the shop is leaving", () => {
    const discounts = [{percent: 50, planTier: 'proplus', validUntil: null}];
    expect(
      renewalMonthlyTotal({plan: proplus, extraBranches: 0, discounts}),
    ).toBe(249_500);
    expect(
      renewalMonthlyTotal({
        plan: proplus,
        pendingPlan: pro,
        extraBranches: 0,
        discounts,
      }),
    ).toBe(299_000);
  });

  it('is nothing without a plan', () => {
    expect(
      renewalMonthlyTotal({plan: null, extraBranches: 0, discounts: []}),
    ).toBe(0);
  });
});

describe('settlement', () => {
  it("takes whole so'm and every answer when the balance covers it", () => {
    expect(
      settlement({unsettled: 617.48, answers: 37, balance: 10_000}),
    ).toEqual({amount: 617, answers: 37});
  });

  it('takes only what the balance holds and leaves the rest owed', () => {
    expect(settlement({unsettled: 1_000, answers: 60, balance: 250.9})).toEqual(
      {
        amount: 250,
        answers: 15,
      },
    );
  });

  it("never takes the coming renewal's money", () => {
    // 10 so'm were spendable above the month; the last answer cost 15.21.
    expect(
      settlement({
        unsettled: 15.21,
        answers: 1,
        balance: 249_010,
        reserve: 249_000,
      }),
    ).toEqual({amount: 10, answers: 0});
    // Short of the month already (a renewal that did not happen).
    expect(
      settlement({
        unsettled: 500,
        answers: 30,
        balance: 200_000,
        reserve: 249_000,
      }),
    ).toEqual({amount: 0, answers: 0});
  });

  it("takes nothing below one so'm or from an empty balance", () => {
    expect(settlement({unsettled: 0.6, answers: 1, balance: 10_000})).toEqual({
      amount: 0,
      answers: 0,
    });
    expect(settlement({unsettled: 500, answers: 30, balance: 0})).toEqual({
      amount: 0,
      answers: 0,
    });
  });
});
