import {Tier} from '../../subscription/tier';
import {
  JsonSchemaObject,
  LlmToolDef,
} from '../providers/llm-provider.interface';

/**
 * Declarative catalogue of everything the assistant can read.
 *
 * Two properties make this layer safe by construction:
 *
 *  1. `businessId` is NEVER a tool argument — it comes from the JWT and is
 *     passed by the executor. The model cannot address another tenant.
 *  2. Every handler delegates to an existing, already-reviewed service method.
 *     There is no new query surface here, so there is no new way to get the
 *     `status='Completed'` filter or the +05:00 business day wrong.
 *
 * `minTier` mirrors the `@MinTier` decorators on the corresponding controllers.
 * Tools above the caller's plan are filtered out of the list entirely rather
 * than failing at call time — a model that cannot see a tool cannot promise
 * the owner a report they are not paying for.
 */

export interface ToolContext {
  businessId: string;
  tier: Tier;
  /** Today in the business zone, as YYYY-MM-DD. */
  today: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  minTier: Tier;
  /** Short uz label shown in the UI while the tool runs. */
  label: string;
  /** Cache key params; omit a tool from caching by returning undefined. */
  cacheParams?(args: Record<string, unknown>): Record<string, unknown>;
  run(
    deps: ToolDeps,
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

/** Services the handlers reach into. Injected once by AiToolsService. */
export interface ToolDeps {
  report: {
    getPnl(b: string, r?: Range): Promise<unknown>;
    getStock(b: string, date?: string): Promise<unknown>;
    getProductMovement(b: string, r?: Range): Promise<unknown>;
    getSellers(b: string, r?: Range): Promise<unknown>;
    getCustomers(b: string, r?: Range): Promise<unknown>;
    getImports(b: string, r?: Range): Promise<unknown>;
    getSupplierReturns(b: string, r?: Range): Promise<unknown>;
    getStockTakes(b: string, r?: Range): Promise<unknown>;
    getSales(
      b: string,
      r?: Range,
      g?: 'day' | 'week' | 'month',
    ): Promise<unknown>;
    getTraffic(b: string, r?: Range): Promise<unknown>;
    getShifts(b: string, r?: Range): Promise<unknown>;
    getPaymentMethods(b: string, r?: Range): Promise<unknown>;
    getDiscounts(b: string, r?: Range): Promise<unknown>;
    getCancelled(b: string, r?: Range): Promise<unknown>;
    getDebtAging(b: string): Promise<unknown>;
    getDeadStock(b: string, branchId?: string, days?: number): Promise<unknown>;
    getReorder(
      b: string,
      branchId?: string,
      days?: number,
      coverDays?: number,
    ): Promise<unknown>;
    getTransferSuggestions(
      b: string,
      days?: number,
      coverDays?: number,
    ): Promise<unknown>;
    getSuppliers(b: string, r?: Range): Promise<unknown>;
    getAssortment(
      b: string,
      r?: Range,
      dimension?: 'category' | 'brand',
    ): Promise<unknown>;
    getBranchComparison(b: string, r?: Range): Promise<unknown>;
    getTransfers(b: string, r?: Range): Promise<unknown>;
  };
  order: {
    getProductPerformance(
      b: string,
      o?: {from?: string; to?: string; branchId?: string},
    ): Promise<unknown>;
    getSalesSummary(
      b: string,
      o?: {from?: string; to?: string},
    ): Promise<unknown>;
  };
  branch: {findAll(b: string): Promise<unknown>};
  target: {getProgress(b: string, month?: string): Promise<unknown>};
}

export interface Range {
  from?: string;
  to?: string;
  branchId?: string;
}

// ── Shared parameter shapes ──────────────────────────────────────────────────

/**
 * from / to / branchId — the shape 19 of the report endpoints take.
 *
 * Descriptions here are deliberately terse. Every tool schema is re-sent on
 * every iteration of the tool loop, so a sentence written once in this helper
 * is really paid for 19 times per request and 3-ish times per question. The
 * date format, the timezone, the "omit for all time" default and the
 * list_branches lookup are therefore stated ONCE in the system prompt (see
 * prompt.ts, "Tool arguments") instead of on all 57 of these parameters.
 */
function rangeParams(extra: Record<string, unknown> = {}): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      from: {type: 'string', description: 'Start date, inclusive.'},
      to: {type: 'string', description: 'End date, inclusive.'},
      branchId: {type: 'string', description: 'One branch only.'},
      ...extra,
    },
  };
}

function toRange(args: Record<string, unknown>): Range {
  return {
    from: typeof args.from === 'string' ? args.from : undefined,
    to: typeof args.to === 'string' ? args.to : undefined,
    branchId: typeof args.branchId === 'string' ? args.branchId : undefined,
  };
}

/** Same fields as `toRange`, but shaped for the cache-key builder. */
function rangeKey(args: Record<string, unknown>): Record<string, unknown> {
  const r = toRange(args);
  return {from: r.from, to: r.to, branchId: r.branchId};
}

function numArg(args: Record<string, unknown>, key: string, fallback: number) {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ── The catalogue ────────────────────────────────────────────────────────────

export const TOOLS: ToolDefinition[] = [
  // ── Meta ───────────────────────────────────────────────────────────────────
  {
    name: 'list_branches',
    label: 'Filiallar ro‘yxati',
    minTier: 'basic',
    description:
      "List this business's branches (filiallar / do'konlar) with their ids and names. Only needed to turn a branch NAME the owner typed into an id. Every other tool already covers all branches when branchId is omitted, so do not call this just because a question mentions branches in general.",
    parameters: {type: 'object', properties: {}},
    cacheParams: () => ({}),
    run: (d, c) => d.branch.findAll(c.businessId),
  },
  {
    name: 'sales_summary',
    label: 'Sotuv xulosasi',
    minTier: 'basic',
    description:
      'Headline totals for a period: order count, units, revenue, and the cash/card/debt split. The cheapest way to answer "how much did I sell". Use sales_over_time instead when a trend or per-day breakdown is wanted.',
    parameters: rangeParams(),
    cacheParams: (a) => ({from: a.from, to: a.to}),
    run: (d, c, a) =>
      d.order.getSalesSummary(c.businessId, {
        from: typeof a.from === 'string' ? a.from : undefined,
        to: typeof a.to === 'string' ? a.to : undefined,
      }),
  },

  // ── Store / sales ──────────────────────────────────────────────────────────
  {
    name: 'sales_over_time',
    label: 'Sotuvlar dinamikasi',
    minTier: 'basic',
    description:
      'Revenue, receipts, average check, discounts, COGS, profit and margin bucketed by day, week or month. Use for trends, comparisons between periods, and any "which day/week/month" question.',
    parameters: rangeParams({
      groupBy: {
        type: 'string',
        enum: ['day', 'week', 'month'],
        description: 'Bucket size. Defaults to day.',
      },
    }),
    cacheParams: (a) => ({...rangeKey(a), groupBy: a.groupBy}),
    run: (d, c, a) =>
      d.report.getSales(
        c.businessId,
        toRange(a),
        a.groupBy === 'week' || a.groupBy === 'month' ? a.groupBy : 'day',
      ),
  },
  {
    name: 'traffic_heatmap',
    label: 'Trafik (soat × kun)',
    minTier: 'pro',
    description:
      'Orders and revenue per weekday × hour. Answers "when are we busiest", staffing and opening-hours questions.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getTraffic(c.businessId, toRange(a)),
  },
  {
    name: 'discounts',
    label: 'Chegirmalar',
    minTier: 'basic',
    description:
      'Discount totals broken down per cashier, with discounted-receipt count and discount percentage. Use for discount abuse questions.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getDiscounts(c.businessId, toRange(a)),
  },
  {
    name: 'cancelled_receipts',
    label: 'Bekor qilingan cheklar',
    minTier: 'basic',
    description:
      'Cancelled receipts with amount, cashier and timestamp. A classic POS fraud signal when one cashier stands out.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getCancelled(c.businessId, toRange(a)),
  },
  {
    name: 'branch_comparison',
    label: 'Filiallar taqqoslash',
    minTier: 'pro',
    description:
      'EVERY branch side by side in ONE call: revenue, margin, receipts, average check, stock value, turnover. This is the complete answer to any "compare the branches / which shop is doing better" question. Do not fetch branches one at a time and do not call list_branches first — this already returns them all, named.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getBranchComparison(c.businessId, toRange(a)),
  },

  // ── Finance ────────────────────────────────────────────────────────────────
  {
    name: 'pnl',
    label: 'Foyda va zarar',
    minTier: 'pro',
    description:
      'Profit & loss: gross revenue, discounts, returns, net revenue, COGS, gross profit and margin, expenses by category, cash-shift difference, net profit. The answer to "did I actually make money".',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getPnl(c.businessId, toRange(a)),
  },
  {
    name: 'cash_shifts',
    label: 'Kassa smenalari',
    minTier: 'basic',
    description:
      'Closed cash shifts (Z-report): opening float, cash in/out, expected vs counted, shortage/surplus, plus a per-cashier rollup. Repeated shortages by one cashier are the signal to surface. Note: branchId is ignored here — a shift belongs to a register.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getShifts(c.businessId, toRange(a)),
  },
  {
    name: 'payment_methods',
    label: 'To‘lov turlari',
    minTier: 'basic',
    description:
      "Revenue split by payment method (cash / card / transfer / debt), with each method's share.",
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getPaymentMethods(c.businessId, toRange(a)),
  },
  {
    name: 'monthly_target',
    label: 'Oylik reja',
    minTier: 'pro',
    description:
      'Monthly revenue target vs actual, with pace and end-of-month projection. Use for "will I hit my plan" questions.',
    parameters: {
      type: 'object',
      properties: {
        month: {
          type: 'string',
          description: 'YYYY-MM. Defaults to the current month.',
        },
      },
    },
    cacheParams: (a) => ({month: a.month}),
    run: (d, c, a) =>
      d.target.getProgress(
        c.businessId,
        typeof a.month === 'string' ? a.month : undefined,
      ),
  },

  // ── Products & stock ───────────────────────────────────────────────────────
  {
    name: 'product_performance',
    label: 'Mahsulot samaradorligi',
    minTier: 'basic',
    description:
      'Per-product units sold, revenue, profit and profit margin. The tool for "best seller", "most profitable", "worst margin" questions.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) =>
      d.order.getProductPerformance(c.businessId, {
        from: typeof a.from === 'string' ? a.from : undefined,
        to: typeof a.to === 'string' ? a.to : undefined,
        branchId: typeof a.branchId === 'string' ? a.branchId : undefined,
      }),
  },
  {
    name: 'stock_valuation',
    label: 'Ombor qoldig‘i',
    minTier: 'basic',
    description:
      'Stock on hand as of a date: quantity, cost value and retail value per product, plus totals. Answers "how much money is sitting in my warehouse".',
    parameters: {
      type: 'object',
      properties: {
        date: {type: 'string', description: 'As-of date. Defaults to today.'},
      },
    },
    cacheParams: (a) => ({date: a.date}),
    run: (d, c, a) =>
      d.report.getStock(
        c.businessId,
        typeof a.date === 'string' ? a.date : undefined,
      ),
  },
  {
    name: 'product_movement',
    label: 'Tovar harakati',
    minTier: 'basic',
    description:
      'Per-product flow over a period: received in, sold, remaining (kelim → sotuv → qoldiq).',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getProductMovement(c.businessId, toRange(a)),
  },
  {
    name: 'dead_stock',
    label: 'O‘lik tovar',
    minTier: 'pro',
    description:
      'Products with no sales in the last N days: quantity, frozen cash (qty × cost), last sale and last receipt date. Use for "what is not selling" and cash-tied-up questions.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description:
            'Days without a sale. Common values 30, 60, 90. Default 30.',
        },
        branchId: {type: 'string', description: 'Restrict to one branch.'},
      },
    },
    cacheParams: (a) => ({days: a.days, branchId: a.branchId}),
    run: (d, c, a) =>
      d.report.getDeadStock(
        c.businessId,
        typeof a.branchId === 'string' ? a.branchId : undefined,
        numArg(a, 'days', 30),
      ),
  },
  {
    name: 'reorder_suggestions',
    label: 'Buyurtma tavsiyalari',
    minTier: 'pro',
    description:
      'Restock forecast: sales velocity vs stock gives days of cover and a suggested order quantity, grouped by supplier with an estimated cost. Use for "what should I buy" questions.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Velocity window in days. Default 30.',
        },
        coverDays: {
          type: 'number',
          description: 'How many days of stock to target. Default 14.',
        },
        branchId: {type: 'string', description: 'Restrict to one branch.'},
      },
    },
    cacheParams: (a) => ({
      days: a.days,
      coverDays: a.coverDays,
      branchId: a.branchId,
    }),
    run: (d, c, a) =>
      d.report.getReorder(
        c.businessId,
        typeof a.branchId === 'string' ? a.branchId : undefined,
        numArg(a, 'days', 30),
        numArg(a, 'coverDays', 14),
      ),
  },
  {
    name: 'assortment',
    label: 'Assortiment tahlili',
    minTier: 'pro',
    description:
      'Revenue, margin % and share broken down by category or by brand. Use for "which category earns most" questions.',
    parameters: rangeParams({
      dimension: {
        type: 'string',
        enum: ['category', 'brand'],
        description: 'Group by category (default) or brand.',
      },
    }),
    cacheParams: (a) => ({...rangeKey(a), dimension: a.dimension}),
    run: (d, c, a) =>
      d.report.getAssortment(
        c.businessId,
        toRange(a),
        a.dimension === 'brand' ? 'brand' : 'category',
      ),
  },
  {
    name: 'stock_takes',
    label: 'Inventarizatsiya',
    minTier: 'basic',
    description:
      'Stock-take (inventarizatsiya) results: surplus, shortage and their value. Write-offs appear here as type "writeoff".',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getStockTakes(c.businessId, toRange(a)),
  },
  {
    name: 'transfers',
    label: 'Filiallararo ko‘chirish',
    minTier: 'pro',
    description:
      'Completed inter-branch stock transfers: from → to, items, quantity, cost value, who moved it.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getTransfers(c.businessId, toRange(a)),
  },
  {
    name: 'transfer_suggestions',
    label: 'Ko‘chirish tavsiyalari',
    minTier: 'pro',
    description:
      'Rebalancing engine: per product, branches above their cover-days target donate to branches below it, grouped into from → to routes. Only useful for multi-branch businesses.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Velocity window in days. Default 30.',
        },
        coverDays: {
          type: 'number',
          description: 'Target days of cover. Default 14.',
        },
      },
    },
    cacheParams: (a) => ({days: a.days, coverDays: a.coverDays}),
    run: (d, c, a) =>
      d.report.getTransferSuggestions(
        c.businessId,
        numArg(a, 'days', 30),
        numArg(a, 'coverDays', 14),
      ),
  },

  // ── Procurement ────────────────────────────────────────────────────────────
  {
    name: 'goods_receipts',
    label: 'Kirimlar (prixod)',
    minTier: 'basic',
    description:
      'Goods receipts over a period: supplier, amount, paid/unpaid status, item count. Answers "how much did I buy in".',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getImports(c.businessId, toRange(a)),
  },
  {
    name: 'supplier_returns',
    label: 'Ta’minotchiga qaytarish',
    minTier: 'basic',
    description: 'Goods returned to suppliers over a period.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getSupplierReturns(c.businessId, toRange(a)),
  },
  {
    name: 'suppliers',
    label: 'Ta’minotchilar',
    minTier: 'basic',
    description:
      'Per-supplier purchase volume, amount paid, amount still owed, and return rate. Answers "who do I owe money to".',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getSuppliers(c.businessId, toRange(a)),
  },

  // ── People & customers ─────────────────────────────────────────────────────
  {
    name: 'seller_performance',
    label: 'Sotuvchilar',
    minTier: 'basic',
    description:
      'Per-cashier KPIs: orders, revenue, average check, items per receipt. Answers "who is my best seller".',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getSellers(c.businessId, toRange(a)),
  },
  {
    name: 'customers',
    label: 'Mijozlar',
    minTier: 'pro',
    description:
      'New vs returning customers, average check, and top customers by spend for a period.',
    parameters: rangeParams(),
    cacheParams: rangeKey,
    run: (d, c, a) => d.report.getCustomers(c.businessId, toRange(a)),
  },
  {
    name: 'debt_aging',
    label: 'Nasiya muddati',
    minTier: 'pro',
    description:
      'Customer receivables (nasiya) bucketed 0–30 / 30–60 / 60–90 / 90+ days, with total outstanding, collection rate and the biggest debtors. Always an as-of-now snapshot — it takes no date range.',
    parameters: {type: 'object', properties: {}},
    cacheParams: () => ({}),
    run: (d, c) => d.report.getDebtAging(c.businessId),
  },
];

/** Tools the given plan may see, as provider-shaped definitions. */
export function toolDefsForTier(tier: Tier): LlmToolDef[] {
  return TOOLS.filter((t) => tierRank(tier) >= tierRank(t.minTier)).map(
    (t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }),
  );
}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

function tierRank(tier: Tier): number {
  return {free: 0, basic: 1, pro: 2, proplus: 3}[tier] ?? 0;
}
