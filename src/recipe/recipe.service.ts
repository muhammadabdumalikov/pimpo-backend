import {Injectable} from '@nestjs/common';
import {and, asc, eq, gte, inArray, lt, lte, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  branchStock,
  foodSettings,
  inventoryBatches,
  orderItemComponents,
  orderItems,
  orders,
  products,
  saleReturns,
  recipeItems,
  units,
  type FoodSettings,
} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {applyBranchStockDelta, trimLotsToStockTx} from '../common/branch-stock';
import {hasRecipe} from '../common/business-type';
import {businessDayEnd, businessDayStart} from '../common/business-time';
import {generateId} from '../utils/uuid';
import {consumeBatches, type CostingMethod} from '../order/costing';
import {
  assertRecipeGraph,
  expandToStock,
  MAX_RECIPE_DEPTH,
  RecipeGraph,
  RecipeGraphError,
  RecipeKind,
  unitCost,
  usersOf,
} from './recipe-graph';
import {SaveRecipeDto, UpdateFoodSettingsDto} from './dto/recipe.dto';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One line of a recipe as the recipe editor shows it. */
export interface RecipeLineView {
  componentId: string;
  name: string;
  kind: RecipeKind;
  unitId: string | null;
  unitShortName: string | null;
  quantityType: string | null;
  quantity: number;
  takeawayOnly: boolean;
  /** Cost of one unit of the component at today's prices. */
  unitCost: number;
  /** quantity × unitCost. */
  lineCost: number;
}

export interface RecipeView {
  productId: string;
  kind: RecipeKind;
  recipeYield: number | null;
  priceOut: number;
  lines: RecipeLineView[];
  /** Cost of one dish, or of one unit of a semi (recipe ÷ yield). */
  unitCost: number;
  /** Recipe cards that use this one (directly or through others). */
  usedIn: {id: string; name: string}[];
}

/** What one sold dish line drew from stock. */
export interface DishConsumption {
  costTotal: number;
  components: {
    productId: string;
    productName: string;
    quantity: number;
    costTotal: number;
  }[];
}

/**
 * Load the recipe graph reachable from `rootIds` (dish/semi cards): those
 * cards, their recipe lines, and every component down to the stock cards.
 * Breadth-first, a few queries whatever the size; stops on its own because a
 * saved graph is acyclic and at most MAX_RECIPE_DEPTH deep.
 */
export async function loadRecipeGraph(
  db: Db | Tx,
  businessId: string,
  rootIds: string[],
): Promise<RecipeGraph> {
  const graph: RecipeGraph = new Map();
  let frontier = [...new Set(rootIds)];
  // Root level + MAX_RECIPE_DEPTH component levels, plus slack for a graph
  // written before a rule tightened — expandToStock reports what is missing.
  for (let level = 0; frontier.length > 0 && level <= MAX_RECIPE_DEPTH + 2; level++) {
    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        kind: products.kind,
        recipeYield: products.recipeYield,
        priceIn: products.priceIn,
      })
      .from(products)
      .where(
        and(eq(products.businessId, businessId), inArray(products.id, frontier)),
      );
    for (const r of rows) {
      graph.set(r.id, {
        id: r.id,
        name: r.name,
        kind: (hasRecipe(r.kind) ? r.kind : 'stock') as RecipeKind,
        recipeYield: r.recipeYield,
        priceIn: Number(r.priceIn),
        lines: [],
      });
    }
    const recipeIds = rows.filter((r) => hasRecipe(r.kind)).map((r) => r.id);
    if (recipeIds.length === 0) break;
    const lines = await db
      .select({
        productId: recipeItems.productId,
        componentId: recipeItems.componentId,
        quantity: recipeItems.quantity,
        takeawayOnly: recipeItems.takeawayOnly,
      })
      .from(recipeItems)
      .where(
        and(
          eq(recipeItems.businessId, businessId),
          inArray(recipeItems.productId, recipeIds),
        ),
      )
      .orderBy(asc(recipeItems.sortOrder), asc(recipeItems.createdAt));
    for (const l of lines) {
      graph.get(l.productId)!.lines.push({
        componentId: l.componentId,
        quantity: l.quantity,
        takeawayOnly: l.takeawayOnly,
      });
    }
    frontier = [...new Set(lines.map((l) => l.componentId))].filter(
      (id) => !graph.has(id),
    );
  }
  return graph;
}

/**
 * Sell `quantity` of a dish inside the sale's transaction: open its recipe down
 * to stock cards and draw each from the branch's lots (consumeBatches — same
 * FIFO/AVERAGE costing as a retail line, oversell allowed: FASTFOOD.md Q4),
 * moving branch_stock/products.quantity by the same amount. The dish card's
 * own stock is never touched. Ingredients are drawn in id order so two
 * concurrent sales lock the same lots in the same order.
 */
export async function consumeDishTx(
  tx: Tx,
  args: {
    businessId: string;
    branchId: string;
    method: CostingMethod;
    graph: RecipeGraph;
    dishId: string;
    quantity: number;
    takeaway: boolean;
  },
): Promise<DishConsumption> {
  let leaves: Map<string, number>;
  try {
    leaves = expandToStock(args.graph, args.dishId, args.quantity, args.takeaway);
  } catch (err) {
    graphError(err, args.graph);
  }
  const components: DishConsumption['components'] = [];
  let costTotal = 0;
  for (const productId of [...leaves.keys()].sort()) {
    const qty = leaves.get(productId)!;
    const leaf = args.graph.get(productId)!;
    const c = await consumeBatches(
      tx,
      args.businessId,
      productId,
      qty,
      args.method,
      leaf.priceIn,
      0, // an ingredient is not sold — only its cost matters here
      args.branchId,
    );
    await applyBranchStockDelta(tx, args.businessId, productId, args.branchId, -qty);
    components.push({
      productId,
      productName: leaf.name,
      quantity: qty,
      costTotal: c.costTotal,
    });
    costTotal += c.costTotal;
  }
  return {costTotal: round2(costTotal), components};
}

/**
 * Put back what a sold dish line drew (order_item_components), or `fraction`
 * of it for a partial return: one fresh lot per ingredient at the unit cost it
 * was drawn at, plus branch/product stock. Returns how many ingredient rows
 * were restored — 0 means the line drew nothing (not a dish, or no recipe).
 */
export async function restoreDishComponentsTx(
  tx: Tx,
  args: {
    businessId: string;
    branchId: string;
    orderItemId: string;
    fraction: number;
  },
): Promise<number> {
  const rows = await tx
    .select({
      productId: orderItemComponents.productId,
      quantity: orderItemComponents.quantity,
      costTotal: orderItemComponents.costTotal,
      priceOut: products.priceOut,
    })
    .from(orderItemComponents)
    // Inner join: an ingredient card deleted since has no stock to return to.
    .innerJoin(products, eq(products.id, orderItemComponents.productId))
    .where(
      and(
        eq(orderItemComponents.businessId, args.businessId),
        eq(orderItemComponents.orderItemId, args.orderItemId),
      ),
    );
  let restored = 0;
  for (const row of rows) {
    const qty = Math.round(row.quantity * args.fraction * 1000) / 1000;
    if (!(qty > 0) || !row.productId) continue;
    const unit = row.quantity > 0 ? Number(row.costTotal) / row.quantity : 0;
    await tx.insert(inventoryBatches).values({
      id: generateId(),
      businessId: args.businessId,
      productId: row.productId,
      branchId: args.branchId,
      receiptItemId: null,
      priceIn: round2(unit).toFixed(2),
      priceOut: row.priceOut,
      qtyReceived: qty,
      qtyRemaining: qty,
    });
    await applyBranchStockDelta(tx, args.businessId, row.productId, args.branchId, qty);
    // Coming back onto a deficit (the ingredient was oversold since) covers
    // the deficit first, exactly like a delivery does.
    await trimLotsToStockTx(tx, args.businessId, row.productId, args.branchId);
    restored++;
  }
  return restored;
}

/** Map a graph rule breach onto the error the recipe editor shows. */
function graphError(err: unknown, graph: RecipeGraph): never {
  if (err instanceof RecipeGraphError) {
    const name = graph.get(err.nodeId)?.name ?? err.nodeId;
    if (err.reason === 'cycle') {
      throw new AppException(ErrorCode.RECIPE_CYCLE, {name});
    }
    if (err.reason === 'too_deep') {
      throw new AppException(ErrorCode.RECIPE_TOO_DEEP, {max: MAX_RECIPE_DEPTH});
    }
    if (err.reason === 'no_yield') {
      throw new AppException(ErrorCode.RECIPE_YIELD_REQUIRED);
    }
    throw new AppException(ErrorCode.RECIPE_COMPONENT_NOT_FOUND);
  }
  throw err;
}

@Injectable()
export class RecipeService {
  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  private async loadRecipeCard(businessId: string, productId: string) {
    const [product] = await this.db
      .select({
        id: products.id,
        name: products.name,
        kind: products.kind,
        recipeYield: products.recipeYield,
        priceOut: products.priceOut,
      })
      .from(products)
      .where(and(eq(products.businessId, businessId), eq(products.id, productId)))
      .limit(1);
    if (!product) throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
    if (!hasRecipe(product.kind)) {
      throw new AppException(ErrorCode.RECIPE_NOT_SUPPORTED);
    }
    return product;
  }

  /** Every dish/semi card of the business — the graph the rules run over. */
  private async loadBusinessGraph(db: Db | Tx, businessId: string) {
    const roots = await db
      .select({id: products.id})
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          inArray(products.kind, ['dish', 'semi']),
        ),
      );
    return loadRecipeGraph(
      db,
      businessId,
      roots.map((r) => r.id),
    );
  }

  async getRecipe(businessId: string, productId: string): Promise<RecipeView> {
    const product = await this.loadRecipeCard(businessId, productId);
    const graph = await this.loadBusinessGraph(this.db, businessId);
    const node = graph.get(productId)!;
    const memo = new Map<string, number>();

    const componentIds = node.lines.map((l) => l.componentId);
    const meta = componentIds.length
      ? await this.db
          .select({
            id: products.id,
            unitId: products.unitId,
            quantityType: products.quantityType,
            unitShortName: units.shortName,
          })
          .from(products)
          .leftJoin(units, eq(units.id, products.unitId))
          .where(
            and(
              eq(products.businessId, businessId),
              inArray(products.id, componentIds),
            ),
          )
      : [];
    const metaById = new Map(meta.map((m) => [m.id, m]));

    const lines: RecipeLineView[] = node.lines.map((l) => {
      const comp = graph.get(l.componentId)!;
      const m = metaById.get(l.componentId);
      const cost = unitCost(graph, l.componentId, memo);
      return {
        componentId: l.componentId,
        name: comp.name,
        kind: comp.kind,
        unitId: m?.unitId ?? null,
        unitShortName: m?.unitShortName ?? null,
        quantityType: m?.quantityType ?? null,
        quantity: l.quantity,
        takeawayOnly: l.takeawayOnly,
        unitCost: round2(cost),
        lineCost: round2(l.quantity * cost),
      };
    });

    return {
      productId,
      kind: node.kind,
      recipeYield: product.recipeYield,
      priceOut: Number(product.priceOut),
      lines,
      unitCost: round2(unitCost(graph, productId, memo)),
      usedIn: [...usersOf(graph, productId)]
        .map((id) => ({id, name: graph.get(id)!.name}))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * Replace a dish/semi card's recipe. Refuses unknown, duplicate or zero
   * lines, a semi without a yield, and any edit that would make some recipe
   * reach itself or nest deeper than MAX_RECIPE_DEPTH. Afterwards the card —
   * and every recipe card that uses it — gets its priceIn re-derived, so the
   * catalogue's cost column follows the recipe.
   */
  async saveRecipe(
    businessId: string,
    productId: string,
    dto: SaveRecipeDto,
  ): Promise<RecipeView> {
    const product = await this.loadRecipeCard(businessId, productId);
    const recipeYield =
      dto.recipeYield !== undefined ? dto.recipeYield : product.recipeYield;
    if (product.kind === 'semi' && !(recipeYield && recipeYield > 0)) {
      throw new AppException(ErrorCode.RECIPE_YIELD_REQUIRED);
    }

    const componentIds = dto.lines.map((l) => l.componentId);
    const found = componentIds.length
      ? await this.db
          .select({id: products.id, name: products.name})
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.isActive, true),
              inArray(products.id, componentIds),
            ),
          )
      : [];
    const nameOf = new Map(found.map((f) => [f.id, f.name]));
    const seen = new Set<string>();
    for (const line of dto.lines) {
      if (line.componentId === productId) {
        throw new AppException(ErrorCode.RECIPE_CYCLE, {name: product.name});
      }
      const name = nameOf.get(line.componentId);
      if (!name) throw new AppException(ErrorCode.RECIPE_COMPONENT_NOT_FOUND);
      if (seen.has(line.componentId)) {
        throw new AppException(ErrorCode.RECIPE_COMPONENT_DUPLICATE, {name});
      }
      seen.add(line.componentId);
      if (!(line.quantity > 0)) {
        throw new AppException(ErrorCode.RECIPE_QUANTITY_INVALID, {name});
      }
    }

    await this.db.transaction(async (tx) => {
      // Serialise recipe edits of one business: two concurrent saves could
      // each pass the cycle check and together close a loop.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${'recipe:' + businessId}))`,
      );

      const graph = await this.loadBusinessGraph(tx, businessId);
      const node = graph.get(productId)!;
      node.recipeYield = product.kind === 'semi' ? recipeYield : null;
      node.lines = dto.lines.map((l) => ({
        componentId: l.componentId,
        quantity: l.quantity,
        takeawayOnly: l.takeawayOnly ?? false,
      }));
      // New components may not be in the graph yet (a stock card nothing
      // used before): load them so the rules can see their kinds.
      const missing = node.lines
        .map((l) => l.componentId)
        .filter((id) => !graph.has(id));
      if (missing.length) {
        for (const [id, n] of await loadRecipeGraph(tx, businessId, missing)) {
          if (!graph.has(id)) graph.set(id, n);
        }
      }
      try {
        assertRecipeGraph(graph);
      } catch (err) {
        graphError(err, graph);
      }

      await tx
        .delete(recipeItems)
        .where(
          and(
            eq(recipeItems.businessId, businessId),
            eq(recipeItems.productId, productId),
          ),
        );
      if (node.lines.length) {
        await tx.insert(recipeItems).values(
          node.lines.map((l, i) => ({
            id: generateId(),
            businessId,
            productId,
            componentId: l.componentId,
            quantity: l.quantity,
            takeawayOnly: l.takeawayOnly,
            sortOrder: i,
          })),
        );
      }

      // Re-derive the cost of this card and of everything built from it.
      const memo = new Map<string, number>();
      for (const id of [productId, ...usersOf(graph, productId)]) {
        await tx
          .update(products)
          .set({
            priceIn: round2(unitCost(graph, id, memo)).toFixed(2),
            ...(id === productId && product.kind === 'semi'
              ? {recipeYield}
              : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(products.businessId, businessId), eq(products.id, id)));
      }
    });

    return this.getRecipe(businessId, productId);
  }

  // ─── Reports (FASTFOOD.md Q13) ────────────────────────────────────────────

  /**
   * Menu cost: every dish and semi-finished item at TODAY's ingredient costs
   * (the cards' weighted-average priceIn, opened through the recipes live —
   * not the priceIn snapshot a recipe save left on the card), against its
   * price and the shop's food-cost target.
   */
  async getMenuCost(businessId: string) {
    const cards = await this.db
      .select({
        id: products.id,
        name: products.name,
        kind: products.kind,
        categoryId: products.categoryId,
        priceOut: products.priceOut,
        recipeYield: products.recipeYield,
        unitShortName: units.shortName,
        quantityType: products.quantityType,
      })
      .from(products)
      .leftJoin(units, eq(units.id, products.unitId))
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.isActive, true),
          inArray(products.kind, ['dish', 'semi']),
        ),
      );
    const graph = await loadRecipeGraph(
      this.db,
      businessId,
      cards.map((c) => c.id),
    );
    const memo = new Map<string, number>();
    const {foodCostTarget} = await this.getSettings(businessId);
    const rows = cards.map((c) => {
      const node = graph.get(c.id);
      const hasRecipe = !!node && node.lines.length > 0;
      let cost = 0;
      try {
        cost = hasRecipe ? unitCost(graph, c.id, memo) : 0;
      } catch {
        cost = 0;
      }
      const price = c.kind === 'dish' ? Number(c.priceOut) : 0;
      const pct = price > 0 && cost > 0 ? (cost / price) * 100 : null;
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        categoryId: c.categoryId,
        unitShortName: c.unitShortName,
        quantityType: c.quantityType,
        recipeYield: c.recipeYield,
        hasRecipe,
        price: round2(price),
        cost: round2(cost),
        margin: price > 0 ? round2(price - cost) : null,
        foodCostPercent: pct === null ? null : round2(pct),
        overTarget: pct !== null && pct > foodCostTarget,
      };
    });
    rows.sort((a, b) => (b.foodCostPercent ?? -1) - (a.foodCostPercent ?? -1));
    return {foodCostTarget, rows};
  }

  /** Every stock card below zero, with what the deficit is worth at cost. */
  async getNegativeStock(businessId: string) {
    const rows = await this.db
      .select({
        id: products.id,
        name: products.name,
        quantity: branchStock.quantity,
        priceIn: products.priceIn,
        unitShortName: units.shortName,
        quantityType: products.quantityType,
        updatedAt: branchStock.updatedAt,
      })
      .from(branchStock)
      .innerJoin(products, eq(products.id, branchStock.productId))
      .leftJoin(units, eq(units.id, products.unitId))
      .where(
        and(
          eq(branchStock.businessId, businessId),
          eq(products.kind, 'stock'),
          eq(products.isActive, true),
          lt(branchStock.quantity, 0),
        ),
      )
      .orderBy(asc(branchStock.quantity));
    return rows.map((r) => {
      const quantity = Math.round(r.quantity * 1000) / 1000;
      return {
        ...r,
        quantity,
        priceIn: Number(r.priceIn),
        value: round2(-quantity * Number(r.priceIn)),
      };
    });
  }

  // ─── Kitchen ticket ───────────────────────────────────────────────────────

  /**
   * What the kitchen ticket prints under a combo (FASTFOOD.md Q26): for every
   * dish whose recipe holds other dishes, its direct parts that someone hands
   * over — the dishes, and stock cards that are themselves on the menu (a can
   * of cola) — with how many. Names and counts only, no cost, so the till can
   * read it without the recipe permission.
   */
  async getCombos(
    businessId: string,
  ): Promise<Record<string, {name: string; quantity: number}[]>> {
    const rows = await this.db
      .select({
        productId: recipeItems.productId,
        name: products.name,
        kind: products.kind,
        showInMenu: products.showInMenu,
        quantity: recipeItems.quantity,
      })
      .from(recipeItems)
      .innerJoin(products, eq(products.id, recipeItems.componentId))
      .where(eq(recipeItems.businessId, businessId))
      .orderBy(asc(recipeItems.sortOrder));
    const byDish = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byDish.get(r.productId) ?? [];
      list.push(r);
      byDish.set(r.productId, list);
    }
    const out: Record<string, {name: string; quantity: number}[]> = {};
    for (const [dishId, parts] of byDish) {
      if (!parts.some((p) => p.kind === 'dish')) continue;
      out[dishId] = parts
        .filter((p) => p.kind === 'dish' || (p.kind === 'stock' && p.showInMenu))
        .map((p) => ({name: p.name, quantity: p.quantity}));
    }
    return out;
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────

  /**
   * The fast-food dashboard's two own numbers (FASTFOOD.md Q16), for the
   * business days `from`..`to`:
   *  - food cost — cost of what was sold over what it sold for, net of the
   *    returns dated in the range (their refund and the cost that went back
   *    into stock), against the shop's target;
   *  - stock cards below zero — ingredients sold ahead of their nakladnoy.
   */
  async getSummary(businessId: string, from: string, to: string) {
    const start = businessDayStart(from);
    const end = businessDayEnd(to);
    const [sales] = await this.db
      .select({
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          gte(orders.createdAt, start),
          lte(orders.createdAt, end),
        ),
      );
    const [cogs] = await this.db
      .select({cost: sql<string>`COALESCE(SUM(${orderItems.costTotal}), 0)`})
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          gte(orders.createdAt, start),
          lte(orders.createdAt, end),
        ),
      );
    const [ret] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${saleReturns.totalAmount}), 0)`,
        restocked: sql<string>`COALESCE(SUM(${saleReturns.restockedCost}), 0)`,
      })
      .from(saleReturns)
      .where(
        and(
          eq(saleReturns.businessId, businessId),
          gte(saleReturns.createdAt, start),
          lte(saleReturns.createdAt, end),
        ),
      );
    const revenue = round2(Number(sales?.revenue ?? 0) - Number(ret?.total ?? 0));
    const cost = round2(Number(cogs?.cost ?? 0) - Number(ret?.restocked ?? 0));

    const negative = await this.db
      .select({
        id: products.id,
        name: products.name,
        quantity: branchStock.quantity,
        unitShortName: units.shortName,
        quantityType: products.quantityType,
      })
      .from(branchStock)
      .innerJoin(products, eq(products.id, branchStock.productId))
      .leftJoin(units, eq(units.id, products.unitId))
      .where(
        and(
          eq(branchStock.businessId, businessId),
          eq(products.kind, 'stock'),
          eq(products.isActive, true),
          lt(branchStock.quantity, 0),
        ),
      )
      .orderBy(asc(branchStock.quantity))
      .limit(50);

    const {foodCostTarget} = await this.getSettings(businessId);
    return {
      from,
      to,
      revenue,
      cost,
      foodCostPercent: revenue > 0 ? round2((cost / revenue) * 100) : null,
      foodCostTarget,
      negativeCount: negative.length,
      negative: negative.map((n) => ({
        ...n,
        quantity: Math.round(n.quantity * 1000) / 1000,
      })),
    };
  }

  // ─── Food settings ────────────────────────────────────────────────────────

  async getSettings(
    businessId: string,
  ): Promise<Pick<FoodSettings, 'notePresets'> & {foodCostTarget: number}> {
    const [row] = await this.db
      .select()
      .from(foodSettings)
      .where(eq(foodSettings.businessId, businessId))
      .limit(1);
    return {
      notePresets: row?.notePresets ?? [],
      foodCostTarget: row ? Number(row.foodCostTarget) : 35,
    };
  }

  async updateSettings(businessId: string, dto: UpdateFoodSettingsDto) {
    const current = await this.getSettings(businessId);
    // Trimmed, blanks and repeats dropped, first spelling kept.
    const presets =
      dto.notePresets !== undefined
        ? [
            ...new Map(
              dto.notePresets
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p) => [p.toLocaleLowerCase(), p] as const),
            ).values(),
          ]
        : current.notePresets;
    const target = dto.foodCostTarget ?? current.foodCostTarget;
    await this.db
      .insert(foodSettings)
      .values({
        businessId,
        notePresets: presets,
        foodCostTarget: target.toFixed(2),
      })
      .onConflictDoUpdate({
        target: foodSettings.businessId,
        set: {
          notePresets: presets,
          foodCostTarget: target.toFixed(2),
          updatedAt: new Date(),
        },
      });
    return this.getSettings(businessId);
  }
}
