import {astVisitor, parse, Statement} from 'pgsql-ast-parser';
import {ALLOWED_FUNCTIONS, ALLOWED_TABLES} from './ai-sql.constants';

/**
 * Static validation of LLM-generated SQL.
 *
 * IMPORTANT — this is NOT the security boundary. The boundary is, in order:
 *   1. a dedicated role with SELECT on an allowlist of tables and nothing else;
 *   2. row-level security keyed on `app.business_id`;
 *   3. `BEGIN READ ONLY` plus a server-side `default_transaction_read_only`;
 *   4. the extended wire protocol, which makes multi-statement input a
 *      Postgres-level error;
 *   5. `EXPLAIN` before execution, which runs the real grammar and the real
 *      privilege checks.
 *
 * What this file adds on top is a *fast, legible* rejection: it turns
 * "permission denied for table store_bots" into a sentence the model can act
 * on, and it stops obviously hostile input before it costs a round trip.
 * Everything here is defence in depth — none of it is load-bearing alone.
 */

export class SqlRejection extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SqlRejection';
  }
}

const MAX_LEN = 8_000;

/**
 * Lexical rejections. Each one has a Postgres-level counterpart; the regex is
 * only here to fail fast with a clear reason.
 */
const LEXICAL_DENY: [RegExp, string][] = [
  // Control characters are exactly what we are looking for here — the rule is
  // guarding against them appearing by accident, which is not the case.
  /* eslint-disable no-control-regex */
  [/\u0000/, 'NUL byte'],
  [/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/, 'control character'],
  /* eslint-enable no-control-regex */
  [/--/, 'line comment'],
  [/\/\*/, 'block comment'],
  [/\$[A-Za-z_]*\$/, 'dollar-quoted string'],
  [/\bpg_[a-z_]+/i, 'pg_* catalog or function'],
  [/\binformation_schema\b/i, 'information_schema'],
  [/\bdblink\b|\bpostgres_fdw\b/i, 'dblink / foreign data wrapper'],
  [/\blo_(import|export)\b/i, 'large-object file I/O'],
  [/\bcurrent_setting\b|\bset_config\b/i, 'runtime configuration access'],
  [/\bcopy\b/i, 'COPY'],
  [/\bset\s+(local\s+|session\s+)?role\b/i, 'SET ROLE'],
];

/**
 * Validates and returns the SQL to execute.
 *
 * @throws SqlRejection with a `code` the repair loop feeds back to the model.
 */
export function validateSelect(raw: string): string {
  const sql = raw.trim().replace(/;+\s*$/, ''); // one trailing `;` is forgivable

  if (!sql) throw new SqlRejection('EMPTY', 'The query was empty.');
  if (sql.length > MAX_LEN) {
    throw new SqlRejection(
      'TOO_LONG',
      `The query is longer than ${MAX_LEN} characters. Simplify it.`,
    );
  }
  if (sql.includes(';')) {
    throw new SqlRejection(
      'MULTI_STATEMENT',
      'Only one statement is allowed. Remove the semicolon and everything after it.',
    );
  }

  for (const [re, label] of LEXICAL_DENY) {
    if (re.test(sql)) {
      throw new SqlRejection('FORBIDDEN_TOKEN', `Not allowed: ${label}.`);
    }
  }

  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch (err) {
    throw new SqlRejection(
      'PARSE_ERROR',
      `The SQL could not be parsed: ${(err as Error).message}`,
    );
  }

  if (statements.length !== 1) {
    throw new SqlRejection(
      'MULTI_STATEMENT',
      'Exactly one statement is allowed.',
    );
  }

  const statement = statements[0];
  if (statement.type !== 'select' && statement.type !== 'with') {
    throw new SqlRejection(
      'NOT_A_SELECT',
      `Only SELECT (optionally preceded by WITH) is allowed. Got ${statement.type}.`,
    );
  }

  assertOnlyAllowedRefs(statement);
  return sql;
}

/**
 * Walks the AST rejecting any table or function outside the allowlists.
 *
 * CTE names are collected first and treated as valid table references, so
 * `WITH daily AS (...) SELECT * FROM daily` passes without `daily` needing to
 * be a real table.
 */
function assertOnlyAllowedRefs(statement: Statement): void {
  const cteNames = new Set<string>();
  collectCteNames(statement, cteNames);

  const visitor = astVisitor((v) => ({
    tableRef: (ref) => {
      const name = ref.name.toLowerCase();
      if (!cteNames.has(name) && !ALLOWED_TABLES.has(name)) {
        throw new SqlRejection(
          'TABLE_NOT_ALLOWED',
          `Table "${ref.name}" is not available. Use only the tables listed in the schema you were given.`,
        );
      }
      v.super().tableRef(ref);
    },
    call: (expr) => {
      const fn = expr.function.name.toLowerCase();
      if (!ALLOWED_FUNCTIONS.has(fn)) {
        throw new SqlRejection(
          'FUNCTION_NOT_ALLOWED',
          `The function ${fn}() is not available. Use plain aggregates and date functions.`,
        );
      }
      v.super().call(expr);
    },
    fromCall: (from) => {
      // Set-returning functions in FROM (e.g. LATERAL jsonb_array_elements)
      // are checked by the same allowlist as scalar calls.
      const fn = from.function.name.toLowerCase();
      if (!ALLOWED_FUNCTIONS.has(fn)) {
        throw new SqlRejection(
          'FUNCTION_NOT_ALLOWED',
          `The function ${fn}() is not available in a FROM clause.`,
        );
      }
      v.super().fromCall(from);
    },
  }));

  visitor.statement(statement);
}

/** Recursively gathers CTE aliases so they aren't mistaken for real tables. */
function collectCteNames(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== 'object') return;

  const anyNode = node as Record<string, unknown>;
  if (
    (anyNode.type === 'with' || anyNode.type === 'with recursive') &&
    Array.isArray(anyNode.bind)
  ) {
    for (const binding of anyNode.bind as {alias?: {name?: string}}[]) {
      if (binding?.alias?.name) into.add(binding.alias.name.toLowerCase());
    }
  }

  for (const value of Object.values(anyNode)) {
    if (Array.isArray(value)) {
      for (const item of value) collectCteNames(item, into);
    } else if (value && typeof value === 'object') {
      collectCteNames(value, into);
    }
  }
}
