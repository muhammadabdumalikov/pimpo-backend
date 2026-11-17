import {buildOnboardingState, onboardingSetup, onboardingStepsFor} from './onboarding.steps';

const keys = (type: string) => onboardingStepsFor(type).map((s) => s.key);
const optional = (type: string) =>
  onboardingStepsFor(type)
    .filter((s) => s.optional)
    .map((s) => s.key);

describe('onboardingStepsFor', () => {
  it('orders the steps per business type', () => {
    expect(keys('retail')).toEqual(['product', 'stock', 'sale', 'staff', 'telegram']);
    expect(keys('food')).toEqual(['product', 'sale', 'staff', 'telegram']);
    expect(keys('online')).toEqual(['product', 'store', 'sale', 'telegram']);
  });

  it('marks only staff and telegram optional', () => {
    expect(optional('retail')).toEqual(['staff', 'telegram']);
    expect(optional('food')).toEqual(['staff', 'telegram']);
    expect(optional('online')).toEqual(['telegram']);
  });

  it('reads an unknown or missing type as retail', () => {
    expect(keys('kiosk')).toEqual(keys('retail'));
    expect(keys('')).toEqual(keys('retail'));
    expect(keys(null as unknown as string)).toEqual(keys('retail'));
  });
});

describe('buildOnboardingState', () => {
  it('starts with nothing done', () => {
    const s = buildOnboardingState('retail', {}, false);
    expect(s.steps.every((x) => !x.done)).toBe(true);
    expect(s.completed).toBe(false);
    expect(s.dismissed).toBe(false);
    expect(s.businessType).toBe('retail');
  });

  it('is completed once every required step is done, optional ones aside', () => {
    const s = buildOnboardingState('retail', {product: true, stock: true, sale: true}, false);
    expect(s.completed).toBe(true);
    expect(s.steps.find((x) => x.key === 'staff')?.done).toBe(false);
  });

  it('is not completed while a required step is missing, however many optional ones are done', () => {
    const s = buildOnboardingState(
      'retail',
      {product: true, stock: true, staff: true, telegram: true},
      false,
    );
    expect(s.completed).toBe(false);
  });

  it('counts a sale as settling every required step before it', () => {
    // Sold its last unit, or never keeps stock: the shop is running.
    const s = buildOnboardingState('retail', {product: true, sale: true}, false);
    expect(s.completed).toBe(true);
    expect(s.steps.find((x) => x.key === 'stock')?.done).toBe(true);
    // A sale says nothing about the optional steps.
    expect(s.steps.find((x) => x.key === 'staff')?.done).toBe(false);
    // An online seller who sold by a hand-made order, storefront still off.
    expect(buildOnboardingState('online', {product: true, sale: true}, false).completed).toBe(true);
  });

  it('ignores facts for steps the type does not have', () => {
    // A kitchen with no stock is still complete: the step is not on its list.
    expect(buildOnboardingState('food', {product: true, sale: true, stock: false}, false).completed).toBe(true);
    // An online seller with a retail-only fact set is still short of its store.
    expect(buildOnboardingState('online', {product: true, stock: true}, false).completed).toBe(false);
    expect(buildOnboardingState('online', {product: true, store: true, sale: true}, false).completed).toBe(true);
  });

  it('passes dismissed through without touching the steps', () => {
    const s = buildOnboardingState('retail', {product: true}, true);
    expect(s.dismissed).toBe(true);
    expect(s.completed).toBe(false);
    expect(s.steps[0]).toEqual({key: 'product', done: true, optional: false});
  });
});

describe('onboardingSetup', () => {
  it('points a fresh retail shop at its first step', () => {
    expect(onboardingSetup('retail', {})).toEqual({next: 'product', done: 0, total: 3});
  });

  it('walks the retail steps in order', () => {
    expect(onboardingSetup('retail', {product: true})).toEqual({next: 'stock', done: 1, total: 3});
    expect(onboardingSetup('retail', {product: true, stock: true})).toEqual({
      next: 'sale',
      done: 2,
      total: 3,
    });
    expect(onboardingSetup('retail', {product: true, stock: true, sale: true})).toEqual({
      next: null,
      done: 3,
      total: 3,
    });
  });

  it('reads a shop that has sold as running, whatever its stock is now', () => {
    // Sold everything it received: stock is gone, the sale stays.
    expect(onboardingSetup('retail', {product: true, sale: true})).toEqual({
      next: null,
      done: 3,
      total: 3,
    });
  });

  it('names the first missing step even when a later one is done', () => {
    // An online seller that opened its storefront before adding anything.
    expect(onboardingSetup('online', {store: true})).toEqual({next: 'product', done: 1, total: 3});
  });

  it('ignores the optional steps', () => {
    expect(onboardingSetup('retail', {staff: true, telegram: true})).toEqual({
      next: 'product',
      done: 0,
      total: 3,
    });
  });

  it('uses each type’s own required list', () => {
    expect(onboardingSetup('food', {})).toEqual({next: 'product', done: 0, total: 2});
    expect(onboardingSetup('food', {product: true, stock: false})).toEqual({
      next: 'sale',
      done: 1,
      total: 2,
    });
    expect(onboardingSetup('food', {product: true, sale: true})).toEqual({next: null, done: 2, total: 2});
    expect(onboardingSetup('online', {product: true})).toEqual({next: 'store', done: 1, total: 3});
    expect(onboardingSetup('online', {product: true, store: true, sale: true})).toEqual({
      next: null,
      done: 3,
      total: 3,
    });
    expect(onboardingSetup('kiosk', {})).toEqual(onboardingSetup('retail', {}));
  });

  it('agrees with the card: next is null exactly when the card is completed', () => {
    const flags = ['product', 'stock', 'store', 'sale', 'staff', 'telegram'] as const;
    for (const type of ['retail', 'food', 'online']) {
      for (let mask = 0; mask < 1 << flags.length; mask++) {
        const facts = Object.fromEntries(flags.map((f, i) => [f, (mask & (1 << i)) !== 0]));
        const card = buildOnboardingState(type, facts, mask % 2 === 0);
        const setup = onboardingSetup(type, facts);
        expect(setup.next === null).toBe(card.completed);
        expect(setup.total).toBe(card.steps.filter((s) => !s.optional).length);
        expect(setup.done).toBe(card.steps.filter((s) => !s.optional && s.done).length);
        expect(setup.next).toBe(card.steps.find((s) => !s.optional && !s.done)?.key ?? null);
      }
    }
  });
});
