import {JsonSchemaObject, LlmToolDef} from './providers/llm-provider.interface';

/**
 * Structured results the assistant can render.
 *
 * The model delivers these by *calling a tool* rather than by embedding JSON in
 * its prose. That choice does a lot of work:
 *   • it streams cleanly — prose keeps flowing to the browser while the payload
 *     arrives as a discrete event, instead of the user watching raw JSON type
 *     itself out inside a code fence;
 *   • tool arguments are schema-validated by every provider, so we get the same
 *     contract on Anthropic, OpenAI and Gemini with no per-provider parsing;
 *   • a malformed artifact fails as one tool call the model can retry, not as a
 *     corrupted answer.
 */

export type NumberFormat = 'money' | 'number' | 'percent' | 'date' | 'text';

export interface KpiArtifact {
  kind: 'kpi';
  title?: string;
  items: {
    label: string;
    value: number;
    format?: NumberFormat;
    /** Percent change vs the comparison period, if one was computed. */
    delta?: number;
    /** True when a *fall* is the good outcome (costs, shortages, returns). */
    invertDelta?: boolean;
  }[];
}

export interface TableArtifact {
  kind: 'table';
  title?: string;
  columns: {key: string; label: string; format?: NumberFormat}[];
  rows: Record<string, string | number | null>[];
}

export interface ChartArtifact {
  kind: 'chart';
  title?: string;
  chartType: 'bar' | 'line';
  categories: string[];
  series: {name: string; data: number[]}[];
  format?: NumberFormat;
}

export interface LinkArtifact {
  kind: 'link';
  /** Report id from the frontend catalogue, e.g. "sales", "pnl", "dead-stock". */
  reportId: string;
  label?: string;
  query?: Record<string, string>;
}

export type AiArtifact =
  | KpiArtifact
  | TableArtifact
  | ChartArtifact
  | LinkArtifact;

export const RENDER_TOOL_NAME = 'render_result';

const ARTIFACT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['kpi', 'table', 'chart', 'link'],
      description:
        'kpi = 1-4 headline numbers. table = a ranked list. chart = a trend over time. link = send the owner to the full report page.',
    },
    title: {
      type: 'string',
      description: "Short heading in the user's language.",
    },
    items: {
      type: 'array',
      description: 'kpi only. 1-4 entries.',
      items: {
        type: 'object',
        properties: {
          label: {type: 'string'},
          value: {type: 'number'},
          format: {
            type: 'string',
            enum: ['money', 'number', 'percent', 'date', 'text'],
          },
          delta: {
            type: 'number',
            description: 'Percent change vs the comparison period.',
          },
          invertDelta: {
            type: 'boolean',
            description: 'True when a decrease is good (costs, shortages).',
          },
        },
        required: ['label', 'value'],
      },
    },
    columns: {
      type: 'array',
      description: 'table only. Column definitions, in display order.',
      items: {
        type: 'object',
        properties: {
          key: {type: 'string'},
          label: {type: 'string'},
          format: {
            type: 'string',
            enum: ['money', 'number', 'percent', 'date', 'text'],
          },
        },
        required: ['key', 'label'],
      },
    },
    rows: {
      type: 'array',
      description:
        'table only. Each object keyed by the column keys. Max 50 rows — rank and cut rather than dumping everything.',
      items: {type: 'object'},
    },
    chartType: {
      type: 'string',
      enum: ['bar', 'line'],
      description: 'chart only.',
    },
    categories: {
      type: 'array',
      description: 'chart only. X-axis labels.',
      items: {type: 'string'},
    },
    series: {
      type: 'array',
      description: 'chart only. One entry per line/bar series.',
      items: {
        type: 'object',
        properties: {
          name: {type: 'string'},
          data: {type: 'array', items: {type: 'number'}},
        },
        required: ['name', 'data'],
      },
    },
    format: {
      type: 'string',
      enum: ['money', 'number', 'percent', 'date', 'text'],
      description: 'chart only. How to format the values.',
    },
    reportId: {
      type: 'string',
      description:
        'link only. One of: sales, traffic, discounts, cancelled, pnl, shifts, payment-methods, target, product-performance, stock, product-movement, abc, stock-takes, imports, supplier-returns, sellers, customers, debt-aging, dead-stock, reorder, assortment, suppliers, branch-comparison, transfers, transfer-suggestions.',
    },
    label: {type: 'string', description: 'link only. Button text.'},
    query: {
      type: 'object',
      description:
        'link only. Query string params, e.g. {"from":"2026-08-01"}.',
    },
  },
  required: ['kind'],
};

export const RENDER_TOOL: LlmToolDef = {
  name: RENDER_TOOL_NAME,
  description:
    'Display a structured result in the UI: KPI tiles, a table, a chart, or a link to the full report page. ' +
    'Call this whenever the answer contains numbers the owner will want to scan or export — which is almost always. ' +
    'Call it BEFORE writing your final sentences, then keep your prose short because the numbers are already on screen. ' +
    'You may call it more than once (for example a KPI row and then a table). Never restate a whole table in prose.',
  parameters: ARTIFACT_SCHEMA,
};

/** Narrows a tool-call payload into an artifact, or null when unusable. */
export function parseArtifact(
  args: Record<string, unknown>,
): AiArtifact | null {
  const kind = args.kind;

  if (kind === 'kpi') {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) return null;
    return {
      kind: 'kpi',
      title: str(args.title),
      items: items.slice(0, 4).map((raw) => {
        const it = raw as Record<string, unknown>;
        return {
          label: text(it.label),
          value: Number(it.value ?? 0),
          format: fmt(it.format),
          delta: typeof it.delta === 'number' ? it.delta : undefined,
          invertDelta: it.invertDelta === true,
        };
      }),
    };
  }

  if (kind === 'table') {
    const columns = Array.isArray(args.columns) ? args.columns : [];
    const rows = Array.isArray(args.rows) ? args.rows : [];
    if (!columns.length) return null;
    return {
      kind: 'table',
      title: str(args.title),
      columns: columns.map((raw) => {
        const c = raw as Record<string, unknown>;
        return {
          key: text(c.key),
          label: text(c.label) || text(c.key),
          format: fmt(c.format),
        };
      }),
      // Hard cap: a runaway table would blow up the SSE frame and the DOM alike.
      rows: rows.slice(0, 50) as Record<string, string | number | null>[],
    };
  }

  if (kind === 'chart') {
    const categories = Array.isArray(args.categories) ? args.categories : [];
    const series = Array.isArray(args.series) ? args.series : [];
    if (!categories.length || !series.length) return null;
    return {
      kind: 'chart',
      title: str(args.title),
      chartType: args.chartType === 'line' ? 'line' : 'bar',
      categories: categories.map(text),
      series: series.map((raw) => {
        const s = raw as Record<string, unknown>;
        return {
          name: text(s.name),
          data: (Array.isArray(s.data) ? s.data : []).map(Number),
        };
      }),
      format: fmt(args.format),
    };
  }

  if (kind === 'link' && typeof args.reportId === 'string') {
    return {
      kind: 'link',
      reportId: args.reportId,
      label: str(args.label),
      query: (args.query as Record<string, string> | undefined) ?? undefined,
    };
  }

  return null;
}

/**
 * Coerces a model-supplied value to a display string.
 *
 * Guarded rather than a bare String(): tool arguments are whatever the model
 * emitted, and String({}) yields "[object Object]" in the middle of a table
 * header — a silent cosmetic bug that only shows up in production.
 */
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function fmt(v: unknown): NumberFormat | undefined {
  return typeof v === 'string' &&
    ['money', 'number', 'percent', 'date', 'text'].includes(v)
    ? (v as NumberFormat)
    : undefined;
}
