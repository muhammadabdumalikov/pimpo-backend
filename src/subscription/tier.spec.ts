import {gateTier, includesAiBot, planBusinessType, tierAtLeast} from './tier';

describe('plan tiers of business types', () => {
  it('gates the online plan like Business, the kitchen plan like Standard', () => {
    expect(gateTier('online')).toBe('pro');
    expect(gateTier('food')).toBe('basic');
    expect(tierAtLeast(gateTier('online'), 'pro')).toBe(true);
    expect(tierAtLeast(gateTier('online'), 'proplus')).toBe(false);
  });

  it('sells each plan to its own business type', () => {
    expect(planBusinessType('online')).toBe('online');
    expect(planBusinessType('food')).toBe('food');
    expect(planBusinessType('proplus')).toBe('retail');
    expect(planBusinessType('free')).toBe('retail');
  });

  it('carries the AI bot on Business+ and the online seller plan', () => {
    expect(includesAiBot('online')).toBe(true);
    expect(includesAiBot('proplus')).toBe(true);
    expect(includesAiBot('pro')).toBe(false);
    expect(includesAiBot('food')).toBe(false);
    expect(includesAiBot(null)).toBe(false);
  });
});
