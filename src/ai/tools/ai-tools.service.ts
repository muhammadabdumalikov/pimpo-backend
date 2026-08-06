import {CACHE_MANAGER} from '@nestjs/cache-manager';
import {Inject, Injectable, Logger} from '@nestjs/common';
import {Cache} from 'cache-manager';
import {BranchService} from '../../branch/branch.service';
import {CacheKeys, TTL} from '../../cache/cache.util';
import {OrderService} from '../../order/order.service';
import {ReportService} from '../../report/report.service';
import {Tier} from '../../subscription/tier';
import {TargetService} from '../../target/target.service';
import {LlmToolDef} from '../providers/llm-provider.interface';
import {
  ToolContext,
  ToolDeps,
  findTool,
  toolDefsForTier,
} from './tool-registry';

/** Rows beyond this are dropped before a tool result reaches the model. */
const MAX_ARRAY_ITEMS = 40;
/** Absolute ceiling on a serialised tool result. */
const MAX_RESULT_CHARS = 24_000;

@Injectable()
export class AiToolsService {
  private readonly logger = new Logger(AiToolsService.name);
  private readonly deps: ToolDeps;

  constructor(
    report: ReportService,
    order: OrderService,
    branch: BranchService,
    target: TargetService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {
    // Bound once so handlers stay plain data in the registry.
    this.deps = {
      report: {
        getPnl: (b, r) => report.getPnl(b, r),
        getStock: (b, d) => report.getStock(b, d),
        getProductMovement: (b, r) => report.getProductMovement(b, r),
        getSellers: (b, r) => report.getSellers(b, r),
        getCustomers: (b, r) => report.getCustomers(b, r),
        getImports: (b, r) => report.getImports(b, r),
        getSupplierReturns: (b, r) => report.getSupplierReturns(b, r),
        getStockTakes: (b, r) => report.getStockTakes(b, r),
        getSales: (b, r, g) => report.getSales(b, r, g),
        getTraffic: (b, r) => report.getTraffic(b, r),
        getShifts: (b, r) => report.getShifts(b, r),
        getPaymentMethods: (b, r) => report.getPaymentMethods(b, r),
        getDiscounts: (b, r) => report.getDiscounts(b, r),
        getCancelled: (b, r) => report.getCancelled(b, r),
        getDebtAging: (b) => report.getDebtAging(b),
        getDeadStock: (b, br, d) => report.getDeadStock(b, br, d),
        getReorder: (b, br, d, c) => report.getReorder(b, br, d, c),
        getTransferSuggestions: (b, d, c) =>
          report.getTransferSuggestions(b, d, c),
        getSuppliers: (b, r) => report.getSuppliers(b, r),
        getAssortment: (b, r, dim) => report.getAssortment(b, r, dim),
        getBranchComparison: (b, r) => report.getBranchComparison(b, r),
        getTransfers: (b, r) => report.getTransfers(b, r),
      },
      order: {
        getProductPerformance: (b, o) => order.getProductPerformance(b, o),
        getSalesSummary: (b, o) => order.getSalesSummary(b, o),
      },
      branch: {findAll: (b) => branch.findAll(b)},
      target: {getProgress: (b, m) => target.getProgress(b, m)},
    };
  }

  /** Tool definitions this plan is allowed to see. */
  listFor(tier: Tier): LlmToolDef[] {
    return toolDefsForTier(tier);
  }

  /**
   * The shop's branches, for inlining into the system prompt.
   *
   * Worth the extra query: without the ids in the prompt, any question naming a
   * branch spends a whole round-trip on `list_branches` first — measured at
   * ~5,000 input tokens, against ~15 tokens per branch to just include them.
   * Cached like any other tool result, and `null` when there are too many to
   * inline (then the tool stays in play).
   */
  async branchesForPrompt(
    businessId: string,
    max = 15,
  ): Promise<{id: string; name: string}[] | null> {
    try {
      const rows = await this.cache.wrap(
        CacheKeys.aiTool(businessId, 'list_branches', {}),
        () => this.deps.branch.findAll(businessId),
        TTL.AI_TOOL,
      );
      if (!Array.isArray(rows) || !rows.length || rows.length > max)
        return null;
      return rows
        .map((r) => r as {id?: unknown; name?: unknown})
        .filter(
          (r): r is {id: string; name: string} =>
            typeof r.id === 'string' && typeof r.name === 'string',
        )
        .map((r) => ({id: r.id, name: r.name}));
    } catch (err) {
      // A prompt nicety, never a reason to fail the question — the model still
      // has `list_branches` to fall back on.
      this.logger.warn(`branchesForPrompt failed: ${String(err)}`);
      return null;
    }
  }

  /** Human label for the "running…" line in the UI. */
  labelFor(name: string): string {
    return findTool(name)?.label ?? name;
  }

  /**
   * Runs one tool.
   *
   * Never throws: a failure is returned as `{ok: false, result: {error}}` so the
   * model can adapt (pick a different tool, or tell the owner what is missing)
   * instead of the whole answer dying on one bad call.
   */
  async execute(
    ctx: ToolContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ok: boolean; result: unknown}> {
    const tool = findTool(name);
    if (!tool) {
      return {ok: false, result: {error: `Unknown tool "${name}".`}};
    }

    // Defence in depth: the model was never shown this tool, but a stale
    // conversation replayed after a downgrade could still name it.
    if (!this.listFor(ctx.tier).some((t) => t.name === name)) {
      return {
        ok: false,
        result: {
          error: `The "${name}" report is not included in this business's plan.`,
        },
      };
    }

    try {
      const params = tool.cacheParams?.(args);
      const load = () => tool.run(this.deps, ctx, args);

      const raw = params
        ? await this.cache.wrap(
            CacheKeys.aiTool(ctx.businessId, name, params),
            load,
            TTL.AI_TOOL,
          )
        : await load();

      return {ok: true, result: compact(raw)};
    } catch (err) {
      this.logger.warn(
        `Tool ${name} failed for business ${ctx.businessId}: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
      return {
        ok: false,
        result: {
          error: 'This report could not be produced. Try a different period.',
        },
      };
    }
  }
}

/**
 * Trims a report payload to something a context window can hold.
 *
 * Reports are shaped `{items: [...], totals: {...}}`, and the totals are what
 * most answers actually need — so long arrays are cut to their head (reports
 * already sort by the interesting metric) and annotated, rather than the whole
 * result being dropped.
 */
function compact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const head = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((v) => compact(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      return {
        _note: `Showing the first ${MAX_ARRAY_ITEMS} of ${value.length} rows, in the report's own sort order.`,
        _totalRows: value.length,
        rows: head,
      };
    }
    return head;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Base64 product images blow the context window and never help an answer.
    if (k === 'image' || k === 'avatarUrl' || k === 'logoUrl') continue;
    out[k] = compact(v, depth + 1);
  }

  const serialised = JSON.stringify(out);
  if (serialised.length > MAX_RESULT_CHARS) {
    return {
      _note:
        'Result was too large to return in full. Narrow the date range or ask for a specific product/branch.',
      preview: serialised.slice(0, MAX_RESULT_CHARS),
    };
  }
  return out;
}
