import {
  assertRecipeGraph,
  expandToStock,
  manualCost,
  RecipeGraph,
  RecipeGraphError,
  RecipeKind,
  RecipeLine,
  unitCost,
  usersOf,
} from './recipe-graph';

function node(
  id: string,
  kind: RecipeKind,
  lines: [string, number, boolean?][] = [],
  extra: {recipeYield?: number; priceIn?: number} = {},
) {
  return {
    id,
    name: id,
    kind,
    recipeYield: extra.recipeYield ?? null,
    priceIn: extra.priceIn ?? 0,
    lines: lines.map(
      ([componentId, quantity, takeawayOnly]): RecipeLine => ({
        componentId,
        quantity,
        takeawayOnly: takeawayOnly ?? false,
      }),
    ),
  };
}

function graphOf(...nodes: ReturnType<typeof node>[]): RecipeGraph {
  return new Map(nodes.map((n) => [n.id, n]));
}

// meat 80 000/kg, mayo 30 000/kg, ketchup 20 000/kg, bread 3 000/pc,
// foil 500/pc, cola 6 000/pc. Sauce: 1.2 kg mayo + 0.8 kg ketchup → 2 kg.
const kitchen = () =>
  graphOf(
    node('meat', 'stock', [], {priceIn: 80000}),
    node('mayo', 'stock', [], {priceIn: 30000}),
    node('ketchup', 'stock', [], {priceIn: 20000}),
    node('bread', 'stock', [], {priceIn: 3000}),
    node('foil', 'stock', [], {priceIn: 500}),
    node('cola', 'stock', [], {priceIn: 6000}),
    node('sauce', 'semi', [['mayo', 1.2], ['ketchup', 0.8]], {recipeYield: 2}),
    node('lavash', 'dish', [
      ['meat', 0.12],
      ['bread', 1],
      ['sauce', 0.03],
      ['foil', 1, true],
    ]),
    node('combo', 'dish', [['lavash', 1], ['cola', 1]]),
  );

describe('expandToStock', () => {
  it('opens a dish down to stock cards, times the quantity', () => {
    const out = expandToStock(kitchen(), 'lavash', 2, true);
    expect(Object.fromEntries(out)).toEqual({
      meat: 0.24,
      bread: 2,
      mayo: 0.036, // 2 × 0.03 kg sauce × 1.2/2
      ketchup: 0.024,
      foil: 2,
    });
  });

  it('skips takeaway-only packaging for dine-in, at every level', () => {
    const out = expandToStock(kitchen(), 'combo', 1, false);
    expect(out.has('foil')).toBe(false);
    expect(out.get('cola')).toBe(1);
    expect(out.get('meat')).toBe(0.12);
  });

  it('merges the same ingredient reached by two paths', () => {
    const g = kitchen();
    g.set(
      'double',
      node('double', 'dish', [['lavash', 1], ['meat', 0.05]]),
    );
    expect(expandToStock(g, 'double', 1, true).get('meat')).toBe(0.17);
  });

  it('drops amounts that round to nothing at gram precision', () => {
    const g = graphOf(
      node('salt', 'stock'),
      node('pinch', 'dish', [['salt', 0.0001]]),
    );
    expect(expandToStock(g, 'pinch', 1, true).size).toBe(0);
  });

  it('refuses a semi without a yield', () => {
    const g = graphOf(
      node('mayo', 'stock'),
      node('sauce', 'semi', [['mayo', 1]]),
      node('dish', 'dish', [['sauce', 0.1]]),
    );
    expect(() => expandToStock(g, 'dish', 1, true)).toThrow(RecipeGraphError);
  });

  it('a dish with no recipe draws nothing', () => {
    const g = graphOf(node('tea', 'dish'));
    expect(expandToStock(g, 'tea', 3, true).size).toBe(0);
  });
});

describe('assertRecipeGraph', () => {
  it('accepts combo → dish → sauce (three levels)', () => {
    expect(() => assertRecipeGraph(kitchen())).not.toThrow();
  });

  it('refuses a fourth level', () => {
    const g = kitchen();
    g.set('meal', node('meal', 'dish', [['combo', 1]]));
    try {
      assertRecipeGraph(g);
      fail('expected too_deep');
    } catch (e) {
      expect((e as RecipeGraphError).reason).toBe('too_deep');
    }
  });

  it('refuses a cycle', () => {
    const g = graphOf(
      node('a', 'semi', [['b', 1]], {recipeYield: 1}),
      node('b', 'semi', [['a', 1]], {recipeYield: 1}),
    );
    try {
      assertRecipeGraph(g);
      fail('expected cycle');
    } catch (e) {
      expect((e as RecipeGraphError).reason).toBe('cycle');
    }
  });

  it('refuses a recipe that contains itself', () => {
    const g = graphOf(node('a', 'dish', [['a', 1]]));
    expect(() => assertRecipeGraph(g)).toThrow(RecipeGraphError);
  });
});

describe('unitCost', () => {
  it('prices a dish from its ingredients, sauce per its yield', () => {
    // meat 9600 + bread 3000 + sauce 0.03 × 26 000 (= (36 000 + 16 000)/2) + foil 500
    expect(unitCost(kitchen(), 'lavash')).toBeCloseTo(13880, 6);
  });

  it('prices a combo from the dishes in it', () => {
    expect(unitCost(kitchen(), 'combo')).toBeCloseTo(19880, 6);
  });
});

describe('usersOf', () => {
  it('finds every recipe that uses a card, transitively', () => {
    expect([...usersOf(kitchen(), 'mayo')].sort()).toEqual([
      'combo',
      'lavash',
      'sauce',
    ]);
  });
});

describe('a recipe card with no recipe yet (hand-typed cost)', () => {
  // Coffee imported from Poster: priced by hand, no ingredients entered.
  const cafe = () => {
    const g = kitchen();
    for (const n of [
      node('latte', 'dish', [], {priceIn: 10650}),
      node('breakfast', 'dish', [['latte', 1], ['lavash', 1]]),
    ]) {
      g.set(n.id, n);
    }
    return g;
  };

  it('costs its own priceIn and draws no stock', () => {
    expect(unitCost(cafe(), 'latte')).toBe(10650);
    expect(expandToStock(cafe(), 'latte', 3, true).size).toBe(0);
    expect(manualCost(cafe(), 'latte', 3, true)).toBe(31950);
  });

  it('counts inside a combo next to the parts that do draw stock', () => {
    const g = cafe();
    const lavash = unitCost(g, 'lavash');
    expect(unitCost(g, 'breakfast')).toBeCloseTo(10650 + lavash, 6);
    expect(manualCost(g, 'breakfast', 2, true)).toBe(21300);
    expect(expandToStock(g, 'breakfast', 2, true).get('bread')).toBe(2);
  });

  it('is 0 when every recipe on the way is entered', () => {
    expect(manualCost(cafe(), 'lavash', 1, true)).toBe(0);
  });
});
