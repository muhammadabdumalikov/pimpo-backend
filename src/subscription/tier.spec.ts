import {gateTier, planBusinessType, sellsAiAddon, tierAtLeast} from './tier';

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

  it('sells the AI add-on on the online plan only', () => {
    expect(sellsAiAddon('online')).toBe(true);
    expect(sellsAiAddon('pro')).toBe(false);
    expect(sellsAiAddon('proplus')).toBe(false);
    expect(sellsAiAddon(null)).toBe(false);
  });
});
