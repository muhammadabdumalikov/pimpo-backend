// Pure recipe arithmetic (FASTFOOD.md §3–4): no database, so every rule here is
// unit-tested on its own (recipe-graph.spec.ts).
//
// A recipe line says "`quantity` of component X, in X's own unit". A dish's
// recipe makes ONE dish; a semi-finished item's recipe makes `yield` units of
// it, so using 30 g of a sauce whose recipe yields 2000 g draws 30/2000 of each
// sauce ingredient. Dishes may contain dishes (a combo). Everything bottoms out
// in stock cards, which are what a sale actually draws from the lots.

export type RecipeKind = 'stock' | 'dish' | 'semi';

export interface RecipeLine {
  componentId: string;
  quantity: number;
  /** Packaging: drawn only when the sale is takeaway. */
  takeawayOnly: boolean;
}

export interface RecipeNode {
  id: string;
  name: string;
  kind: RecipeKind;
  /** semi only: how much one batch of its recipe makes. */
  recipeYield: number | null;
  /** Unit cost of a stock card (its weighted-average priceIn). */
  priceIn: number;
  lines: RecipeLine[];
}

export type RecipeGraph = Map<string, RecipeNode>;

/** How many recipe levels may nest: combo → dish → sauce. */
export const MAX_RECIPE_DEPTH = 3;

// Stock precision: whole grams / millilitres. An ingredient that rounds to
// nothing at this precision is not drawn at all.
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export class RecipeGraphError extends Error {
  constructor(
    readonly reason:
      | 'missing'
      | 'cycle'
      | 'too_deep'
      | 'no_yield',
    readonly nodeId: string,
  ) {
    super(`${reason}: ${nodeId}`);
  }
}

/**
 * Open `quantity` units of a dish (or semi) down to the stock cards it draws:
 * stock card id → total quantity, rounded to 3 decimals, zeros dropped.
 * `takeaway` false skips the takeaway-only (packaging) lines at every level.
 */
export function expandToStock(
  graph: RecipeGraph,
  rootId: string,
  quantity: number,
  takeaway: boolean,
): Map<string, number> {
  const raw = new Map<string, number>();

  const walk = (nodeId: string, factor: number, depth: number) => {
    const node = graph.get(nodeId);
    if (!node) throw new RecipeGraphError('missing', nodeId);
    if (depth > MAX_RECIPE_DEPTH) throw new RecipeGraphError('too_deep', nodeId);
    for (const line of node.lines) {
      if (line.takeawayOnly && !takeaway) continue;
      const comp = graph.get(line.componentId);
      if (!comp) throw new RecipeGraphError('missing', line.componentId);
      const amount = line.quantity * factor;
      if (comp.kind === 'stock') {
        raw.set(comp.id, (raw.get(comp.id) ?? 0) + amount);
      } else if (comp.kind === 'semi') {
        if (!(comp.recipeYield && comp.recipeYield > 0)) {
          throw new RecipeGraphError('no_yield', comp.id);
        }
        walk(comp.id, amount / comp.recipeYield, depth + 1);
      } else {
        walk(comp.id, amount, depth + 1);
      }
    }
  };

  walk(rootId, quantity, 1);

  const out = new Map<string, number>();
  for (const [id, qty] of raw) {
    const q = round3(qty);
    if (q > 0) out.set(id, q);
  }
  return out;
}

/**
 * Check the whole graph after a recipe edit: no recipe reaches itself, and no
 * recipe nests deeper than MAX_RECIPE_DEPTH. Throws RecipeGraphError naming the
 * offending node; the graph must already hold the edited recipe.
 *
 * Depth of a recipe = 1 + the deepest recipe among its components (a recipe of
 * stock cards only is depth 1). Checked for every node, so editing a sauce that
 * a combo uses three levels up is caught too.
 */
export function assertRecipeGraph(graph: RecipeGraph): void {
  const depth = new Map<string, number>();
  const onPath = new Set<string>();

  const visit = (nodeId: string): number => {
    const known = depth.get(nodeId);
    if (known !== undefined) return known;
    const node = graph.get(nodeId);
    if (!node) throw new RecipeGraphError('missing', nodeId);
    if (node.kind === 'stock') {
      depth.set(nodeId, 0);
      return 0;
    }
    if (onPath.has(nodeId)) throw new RecipeGraphError('cycle', nodeId);
    onPath.add(nodeId);
    let deepest = 0;
    for (const line of node.lines) {
      deepest = Math.max(deepest, visit(line.componentId));
    }
    onPath.delete(nodeId);
    const d = node.lines.length > 0 ? deepest + 1 : 0;
    if (d > MAX_RECIPE_DEPTH) throw new RecipeGraphError('too_deep', nodeId);
    depth.set(nodeId, d);
    return d;
  };

  for (const id of graph.keys()) visit(id);
}

/**
 * Theoretical cost of one unit of a card at today's ingredient costs: a stock
 * card's priceIn; a dish's recipe; a semi's recipe divided by its yield. Every
 * line counts (packaging included — the menu-cost view prices a takeaway
 * order, the dearer case). Memoised over `memo` for the whole graph.
 */
export function unitCost(
  graph: RecipeGraph,
  nodeId: string,
  memo: Map<string, number> = new Map(),
): number {
  const known = memo.get(nodeId);
  if (known !== undefined) return known;
  const node = graph.get(nodeId);
  if (!node) throw new RecipeGraphError('missing', nodeId);
  let cost: number;
  if (node.kind === 'stock') {
    cost = node.priceIn;
  } else {
    let batch = 0;
    for (const line of node.lines) {
      batch += line.quantity * unitCost(graph, line.componentId, memo);
    }
    cost =
      node.kind === 'semi'
        ? node.recipeYield && node.recipeYield > 0
          ? batch / node.recipeYield
          : 0
        : batch;
  }
  memo.set(nodeId, cost);
  return cost;
}

/** Every recipe card that uses `nodeId`, directly or through others. */
export function usersOf(graph: RecipeGraph, nodeId: string): Set<string> {
  const parents = new Map<string, string[]>();
  for (const node of graph.values()) {
    for (const line of node.lines) {
      const list = parents.get(line.componentId) ?? [];
      list.push(node.id);
      parents.set(line.componentId, list);
    }
  }
  const out = new Set<string>();
  const stack = [...(parents.get(nodeId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(parents.get(id) ?? []));
  }
  return out;
}
