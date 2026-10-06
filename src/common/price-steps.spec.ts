import {planPrice, type PendingStep} from './price-steps';

const base = {defer: true, olderStock: true};
const chain = (...prices: number[]): PendingStep[] =>
  prices.map((price, i) => ({id: `s${i + 1}`, price}));

describe('planPrice', () => {
  it('a rise goes onto the card at once', () => {
    expect(planPrice({...base, card: 2700, steps: [], proposed: 3000})).toEqual(
      {kind: 'now'},
    );
  });

  it('a rise over a waiting chain still goes on at once (the chain is dropped by the caller)', () => {
    expect(
      planPrice({...base, card: 2700, steps: chain(2200), proposed: 3000}),
    ).toEqual({kind: 'now'});
  });

  it('a drop waits while older stock is on the shelf', () => {
    expect(planPrice({...base, card: 2700, steps: [], proposed: 2200})).toEqual(
      {kind: 'queue', lift: []},
    );
  });

  it('a drop goes on at once when nothing older is left', () => {
    expect(
      planPrice({
        ...base,
        olderStock: false,
        card: 2700,
        steps: [],
        proposed: 2200,
      }),
    ).toEqual({kind: 'now'});
  });

  it('a drop goes on at once when the shop turned waiting off', () => {
    expect(
      planPrice({...base, defer: false, card: 2700, steps: [], proposed: 2200}),
    ).toEqual({kind: 'now'});
  });

  it("the card's own figure is no decision — it leaves the chain alone", () => {
    // The receipt form pre-fills the line from the card; an untouched line
    // must not wipe out a drop that is waiting.
    expect(
      planPrice({...base, card: 2700, steps: chain(2200), proposed: 2700}),
    ).toEqual({kind: 'none'});
  });

  it('the figure the chain already ends on is nothing new', () => {
    expect(
      planPrice({
        ...base,
        card: 2700,
        steps: chain(2500, 2200),
        proposed: 2200,
      }),
    ).toEqual({kind: 'none'});
  });

  it('a cheaper delivery chains behind the waiting ones', () => {
    expect(
      planPrice({...base, card: 2700, steps: chain(2200), proposed: 2000}),
    ).toEqual({kind: 'queue', lift: []});
  });

  it('a delivery between the card and the chain end lifts the cheaper steps', () => {
    // 2700 card, 2500 then 2200 waiting; 2300 arrives: the 2200 goods now sell
    // at 2300 (older goods selling dearer), the 2500 step stays.
    expect(
      planPrice({
        ...base,
        card: 2700,
        steps: chain(2500, 2200),
        proposed: 2300,
      }),
    ).toEqual({kind: 'queue', lift: ['s2']});
    expect(
      planPrice({
        ...base,
        card: 2700,
        steps: chain(2500, 2200),
        proposed: 2600,
      }),
    ).toEqual({kind: 'queue', lift: ['s1', 's2']});
  });

  it('a first price for the tier goes on at once', () => {
    expect(planPrice({...base, card: null, steps: [], proposed: 1500})).toEqual(
      {kind: 'now'},
    );
    expect(planPrice({...base, card: 0, steps: [], proposed: 1500})).toEqual({
      kind: 'now',
    });
  });

  it('no figure, no plan', () => {
    expect(planPrice({...base, card: 2700, steps: [], proposed: null})).toEqual(
      {
        kind: 'none',
      },
    );
    expect(planPrice({...base, card: 2700, steps: [], proposed: 0})).toEqual({
      kind: 'none',
    });
  });

  it('half a tiyin is the same price', () => {
    expect(
      planPrice({...base, card: 2700, steps: [], proposed: 2700.004}),
    ).toEqual({kind: 'none'});
  });
});
