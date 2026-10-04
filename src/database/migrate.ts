// Migration runner: applies drizzle/NNNN_*.sql in name order, each exactly
// once, recording what ran in ops.schema_migrations.
//
// The container runs it before the server (see Dockerfile CMD), so a commit
// that changes schema.ts ships the SQL that backs it — there is no hand step
// to forget. A failed migration exits non-zero and the new server never
// starts. Locally:
//   pnpm db:migrate:status   what is pending (read-only)
//   pnpm db:migrate:verify   rehearse it on DATABASE_URL's real data, rolled back
//   pnpm db:migrate          apply it — to whatever DATABASE_URL points at
// (the pre-push hook in .githooks runs db:check + verify before a push.)
//
// Writing a migration (drizzle/README.md has the full workflow):
//   - Mirror it in schema.ts; `pnpm db:check` proves the two agree.
//   - Make it idempotent (IF NOT EXISTS, guarded DO blocks): the old server
//     keeps serving while the new one migrates, and a file may be re-run.
//   - A file runs as ONE transaction, unless its SQL builds an index
//     CONCURRENTLY (or it carries `-- migrate:no-transaction`): then it runs
//     statement by statement and must leave no INVALID index behind.
//
// Never started by the server itself: a developer's `start:dev` against a
// shared database must not apply their unreviewed SQL.
import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as postgres from 'postgres';
import {needsNoTransaction, splitSqlStatements} from './migrations/sql-split';

/**
 * Every file up to and including this one was applied by hand (psql) before
 * the runner existed. A database that already has the app's tables but no
 * migration record gets these recorded as applied without running them.
 */
export const BASELINE = '0091_schema_parity.sql';

const FILE_NAME = /^\d{4}_[\w-]+\.sql$/;
// Arbitrary, fixed: two containers starting at once take turns.
const ADVISORY_LOCK_KEY = 7405120391;

/**
 * apply  — run what is pending and record it (the container's start).
 * status — report what is pending; change nothing.
 * verify — run what is pending on this database's real data inside one
 *          transaction that is always rolled back: a migration that would
 *          fail here (duplicate rows under a new unique index, NULLs under a
 *          new NOT NULL…) fails before the deploy does. Nothing persists.
 */
export type MigrateMode = 'apply' | 'status' | 'verify';

export interface MigrateOptions {
  url: string;
  dir: string;
  mode?: MigrateMode;
  /**
   * How long a statement may wait for a table lock before giving up. A DDL
   * waiting behind a long query blocks every query queued after it — the till
   * included — so a short wait and a failed deploy beat a frozen shop.
   */
  lockTimeout?: string;
  /** verify only: cap on each rehearsed statement (a backfill can be slow). */
  statementTimeout?: string;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  pending: string[];
  baselined: string[];
  /** verify: files rehearsed and rolled back. */
  verified: string[];
  /** verify: files that can't run in a transaction, so weren't rehearsed. */
  skipped: string[];
}

/** Thrown inside the verify transaction to roll it back on success. */
class Rollback extends Error {}

const setting = (value: string) => `'${value.replace(/'/g, '')}'`;

const checksum = (text: string) =>
  createHash('sha256').update(text).digest('hex');

export function listMigrationFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => FILE_NAME.test(f))
    .sort();
}

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? ((line: string) => console.log(`[migrate] ${line}`));
  const files = listMigrationFiles(opts.dir);
  // One connection: the advisory lock and the session settings belong to it.
  const sql = postgres(opts.url, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const mode = opts.mode ?? 'apply';
  const writes = mode === 'apply';
  const result: MigrateResult = {
    applied: [],
    pending: [],
    baselined: [],
    verified: [],
    skipped: [],
  };

  try {
    if (writes) {
      await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
    }
    if (mode !== 'status') {
      await sql.unsafe(
        `SET lock_timeout = ${setting(opts.lockTimeout ?? '5s')}`,
      );
    }
    if (mode === 'verify') {
      await sql.unsafe(
        `SET statement_timeout = ${setting(opts.statementTimeout ?? '30s')}`,
      );
    }

    const [{exists}] = await sql<{exists: boolean}[]>`
      SELECT to_regclass('ops.schema_migrations') IS NOT NULL AS exists`;
    if (!exists && writes) {
      await sql
        .unsafe(
          `
        CREATE SCHEMA IF NOT EXISTS ops;
        CREATE TABLE IF NOT EXISTS ops.schema_migrations (
          name       varchar(255) PRIMARY KEY,
          checksum   char(64) NOT NULL,
          baseline   boolean NOT NULL DEFAULT false,
          applied_at timestamptz NOT NULL DEFAULT now()
        );`,
        )
        .simple();
    }
    const rows: {name: string; checksum: string}[] = exists
      ? await sql<{name: string; checksum: string}[]>`
          SELECT name, checksum FROM ops.schema_migrations`
      : [];
    const applied = new Map<string, string>(
      rows.map((r): [string, string] => [r.name, r.checksum.trim()]),
    );
    const read = (f: string) => fs.readFileSync(path.join(opts.dir, f), 'utf8');

    // An existing database that predates the runner: record the baseline.
    if (applied.size === 0) {
      const [{hasApp}] = await sql<{hasApp: boolean}[]>`
        SELECT to_regclass('public.businesses') IS NOT NULL AS "hasApp"`;
      if (hasApp) {
        const base = files.filter((f) => f <= BASELINE);
        result.baselined = base;
        if (writes) {
          await sql.begin(async (tx) => {
            for (const f of base) {
              await tx.unsafe(
                `INSERT INTO ops.schema_migrations (name, checksum, baseline)
                 VALUES ($1, $2, true) ON CONFLICT (name) DO NOTHING`,
                [f, checksum(read(f))],
              );
            }
          });
        }
        for (const f of base) applied.set(f, checksum(read(f)));
        log(
          writes
            ? `existing database: recorded ${base.length} migrations up to ${BASELINE} as applied`
            : `existing database without a record: ${base.length} migrations up to ${BASELINE} count as applied`,
        );
      }
    }

    for (const [name, sum] of applied) {
      if (!files.includes(name)) {
        log(`warning: ${name} is recorded as applied but its file is gone`);
      } else if (sum !== checksum(read(name))) {
        log(`warning: ${name} changed after it was applied (not re-run)`);
      }
    }

    result.pending = files.filter((f) => !applied.has(f));
    if (mode === 'status') {
      log(
        result.pending.length
          ? `pending: ${result.pending.join(', ')}`
          : 'up to date',
      );
      return result;
    }

    if (mode === 'verify') {
      // In order and in one transaction, so a file that builds on an earlier
      // pending one sees it. Always rolled back.
      for (const f of result.pending) {
        if (needsNoTransaction(read(f))) result.skipped.push(f);
      }
      const rehearse = result.pending.filter(
        (f) => !result.skipped.includes(f),
      );
      for (const f of result.skipped) {
        log(
          `skipped ${f}: it runs outside a transaction (CONCURRENTLY), so it can't be rehearsed`,
        );
      }
      if (rehearse.length) {
        try {
          await sql.begin(async (tx) => {
            for (const f of rehearse) {
              const started = Date.now();
              try {
                await tx.unsafe(read(f)).simple();
              } catch (err) {
                throw new Error(`${f}: ${(err as Error).message}`);
              }
              result.verified.push(f);
              log(`ok ${f} (${Date.now() - started} ms, rolled back)`);
            }
            throw new Rollback();
          });
        } catch (err) {
          if (!(err instanceof Rollback)) throw err;
        }
      }
      if (!result.pending.length) log('up to date — nothing to verify');
      return result;
    }

    for (const f of result.pending) {
      const text = read(f);
      const started = Date.now();
      if (needsNoTransaction(text)) {
        // Statement by statement, as psql -f would. Not atomic, so each file
        // of this kind must be safe to re-run after a partial failure.
        for (const stmt of splitSqlStatements(text)) {
          await sql.unsafe(stmt).simple();
        }
        // A CONCURRENTLY build that failed leaves an INVALID index, and the
        // file's IF NOT EXISTS would skip it on the next run.
        const invalid = await sql<{name: string}[]>`
          SELECT indexrelid::regclass::text AS name FROM pg_index WHERE NOT indisvalid`;
        if (invalid.length) {
          throw new Error(
            `${f} left INVALID indexes: ${invalid.map((r) => r.name).join(', ')} — ` +
              'DROP them, fix the cause (usually duplicate rows), and redeploy',
          );
        }
        await sql`
          INSERT INTO ops.schema_migrations (name, checksum) VALUES (${f}, ${checksum(text)})`;
      } else {
        // The file and its record commit together, or neither does.
        await sql.begin(async (tx) => {
          await tx.unsafe(text).simple();
          await tx.unsafe(
            'INSERT INTO ops.schema_migrations (name, checksum) VALUES ($1, $2)',
            [f, checksum(text)],
          );
        });
      }
      result.applied.push(f);
      log(`applied ${f} (${Date.now() - started} ms)`);
    }
    if (!result.applied.length) log('up to date');
    return result;
  } finally {
    await sql.end({timeout: 5});
  }
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
]);

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL is not set');
    process.exit(1);
  }
  const mode: MigrateMode = process.argv.includes('--status')
    ? 'status'
    : process.argv.includes('--verify')
      ? 'verify'
      : 'apply';
  migrate({
    url,
    dir: process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, '../../drizzle'),
    mode,
    lockTimeout: process.env.MIGRATE_LOCK_TIMEOUT,
    statementTimeout: process.env.MIGRATE_STATEMENT_TIMEOUT,
  }).then(
    () => process.exit(0),
    (err: unknown) => {
      const code = (err as {code?: string})?.code ?? '';
      // Exit 3 = couldn't reach the database (the pre-push hook warns instead
      // of blocking); anything else is a real failure.
      const unreachable = UNREACHABLE.has(code);
      console.error(
        unreachable
          ? `[migrate] database unreachable (${code})`
          : `[migrate] failed: ${(err as Error)?.message ?? err}`,
      );
      process.exit(unreachable && mode !== 'apply' ? 3 : 1);
    },
  );
}
