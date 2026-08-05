import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type {Sql} from 'postgres';
import {AI_SQL_CLIENT, AI_SQL_DEFAULTS} from './ai-sql.constants';
import {SqlRejection, validateSelect} from './sql-validator';

/**
 * Forces the EXTENDED wire protocol on a `sql.unsafe()` call.
 *
 * postgres-js honours a `simple` flag at runtime but does not declare it in
 * `UnsafeQueryOptions`, hence the cast — which is the entire reason this
 * constant exists as a named thing rather than an inline object.
 *
 * Why it matters: `unsafe()` defaults to `simple: args.length === 0`
 * (node_modules/postgres/cjs/src/index.js:124), and the SIMPLE protocol
 * executes `;`-chained statements. With the extended protocol, Postgres itself
 * rejects multi-statement input with 42601. DO NOT REMOVE.
 */
const EXTENDED_PROTOCOL = {simple: false} as unknown as {prepare?: boolean};

export interface AiSqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

/** Structured detail handed back to the model when a query fails. */
export interface AiSqlError {
  code: string;
  message: string;
  hint?: string;
}

@Injectable()
export class AiSqlService implements OnModuleInit {
  private readonly logger = new Logger(AiSqlService.name);

  constructor(
    @Optional() @Inject(AI_SQL_CLIENT) private readonly sql: Sql | null,
  ) {}

  get enabled(): boolean {
    return this.sql !== null;
  }

  /**
   * Refuses to start if the read-only DSN is misconfigured.
   *
   * The two failures worth crashing over are (a) AI_DATABASE_URL pointing at a
   * privileged role, which would hand the model unfiltered access to every
   * tenant, and (b) the migration not being applied, which produces the same
   * outcome quietly. Both are invisible in normal operation, so they must be
   * caught at boot rather than discovered from a leak.
   */
  async onModuleInit(): Promise<void> {
    if (!this.sql) return;

    const [role] = await this.sql<
      {current_user: string; rolsuper: boolean; rolbypassrls: boolean}[]
    >`SELECT current_user, rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname = current_user`;

    if (role?.rolsuper || role?.rolbypassrls) {
      throw new Error(
        `AI_DATABASE_URL connects as "${role.current_user}", which bypasses row-level ` +
          'security. Point it at the pimpo_ai_ro role created by ' +
          'drizzle/0062_ai_ro_role_rls.sql. Refusing to start.',
      );
    }

    // With no `app.business_id` set, the policies must filter everything out.
    // A non-zero count here means the migration was not applied.
    const [probe] = await this.sql<{n: string}[]>`
      SELECT count(*)::text AS n FROM orders`;
    if (probe?.n !== '0') {
      throw new Error(
        'Row-level security is not filtering pimpo_ai_ro — reading `orders` with ' +
          'no tenant set returned rows. Apply drizzle/0062_ai_ro_role_rls.sql. ' +
          'Refusing to start.',
      );
    }

    this.logger.log(
      `Ad-hoc SQL enabled as "${role.current_user}" with RLS verified.`,
    );
  }

  /**
   * Runs one model-generated SELECT inside a read-only, tenant-scoped,
   * time-boxed transaction.
   */
  async runReadOnly(businessId: string, rawSql: string): Promise<AiSqlResult> {
    if (!this.sql) {
      throw new SqlRejection(
        'DISABLED',
        'Ad-hoc SQL is not enabled on this server.',
      );
    }

    const clean = validateSelect(rawSql);
    const {maxRows, statementTimeoutMs, idleInTxTimeoutMs, maxPlanCost} =
      AI_SQL_DEFAULTS;

    // maxRows + 1 so truncation is detectable without a second query, and the
    // planner can stop early on non-aggregate scans.
    const wrapped = `SELECT * FROM (\n${clean}\n) AS __ai_q LIMIT ${maxRows + 1}`;
    const startedAt = Date.now();

    const rows = await this.sql.begin('read only', async (tx) => {
      // `SET LOCAL x = $1` is a syntax error in Postgres — parameters are not
      // allowed in SET. set_config(..., is_local => true) is the equivalent
      // that *can* be parameterised, which keeps the tenant id off the string
      // interpolation path entirely.
      await tx.unsafe(
        `SELECT set_config('app.business_id', $1, true),
                set_config('statement_timeout', $2, true),
                set_config('idle_in_transaction_session_timeout', $3, true),
                set_config('lock_timeout', '1000', true),
                set_config('search_path', 'public', true)`,
        [businessId, String(statementTimeoutMs), String(idleInTxTimeoutMs)],
      );

      // EXPLAIN without ANALYZE does not execute the query, but it runs the
      // real Postgres grammar and the real privilege checks — catching both
      // syntax our JS parser mis-accepts and any table we never granted — and
      // hands back a cost estimate before a single row is read.
      const plan = (await tx.unsafe(
        `EXPLAIN (FORMAT JSON, COSTS true, VERBOSE false) ${wrapped}`,
        [],
        EXTENDED_PROTOCOL,
      )) as unknown as {'QUERY PLAN': {Plan: {'Total Cost': number}}[]}[];

      const totalCost =
        plan?.[0]?.['QUERY PLAN']?.[0]?.Plan?.['Total Cost'] ?? 0;
      if (totalCost > maxPlanCost) {
        throw new SqlRejection(
          'TOO_EXPENSIVE',
          `The planner estimates this query at cost ${Math.round(totalCost)}, over the ` +
            'limit. Narrow the date range, aggregate more, or drop a join.',
        );
      }

      // `{simple: false}` is the single most important argument in this file.
      // postgres-js defaults `unsafe()` to the SIMPLE protocol when there are
      // no bind parameters, and the simple protocol happily executes
      // `SELECT 1; DROP TABLE x` as two statements. Forcing the extended
      // protocol makes Postgres itself reject multi-statement input (42601),
      // which is a far stronger guarantee than any JS check.
      return tx.unsafe(wrapped, [], EXTENDED_PROTOCOL);
    });

    const list = rows as unknown as Record<string, unknown>[];
    const truncated = list.length > maxRows;
    const out = truncated ? list.slice(0, maxRows) : list;

    return {
      columns: out.length ? Object.keys(out[0]) : [],
      rows: out,
      rowCount: out.length,
      truncated,
      ms: Date.now() - startedAt,
    };
  }

  /**
   * Turns a failure into repair instructions for the model.
   *
   * Postgres' own `hint` text resolves a large share of these unaided, so it is
   * passed through verbatim; the extra note is added where an error code maps
   * onto a schema gotcha the model keeps hitting.
   */
  describeFailure(err: unknown): AiSqlError {
    if (err instanceof SqlRejection) {
      return {code: err.code, message: err.message};
    }

    const pg = err as {
      code?: string;
      message?: string;
      hint?: string;
      position?: string;
    };
    const code = pg?.code ?? 'UNKNOWN';
    const message = pg?.message ?? String(err);

    let hint = pg?.hint;
    if (code === '42883' && /round/i.test(message)) {
      hint =
        'products.quantity is double precision and ROUND has no (double, int) overload. ' +
        'Cast first: ROUND(quantity::numeric, 2).';
    } else if (code === '42P01') {
      hint =
        'That table is not available. Use only the tables in the schema you were given.';
    } else if (code === '42501') {
      hint =
        'That table or column is not readable by the assistant. Pick another.';
    } else if (code === '57014') {
      hint = 'The query timed out. Narrow the date range or aggregate more.';
    }

    return {code, message, hint};
  }
}
