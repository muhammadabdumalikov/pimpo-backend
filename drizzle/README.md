# Database migrations

`src/database/schema.ts` is the single source of truth for the database. The
files here are how a database gets there: plain SQL, applied in file-name
order, each exactly once, by `src/database/migrate.ts`.

## How they get applied

The backend container runs the migrations before it starts the server
(Dockerfile `CMD`). Pushing a commit is enough: the deploy applies its SQL,
then starts the code that needs it. If a migration fails, the container exits
and the new server never starts.

What ran is recorded in `ops.schema_migrations`. Files `0000`–`0091` were
applied by hand before the runner existed; on a database that already has the
app's tables, the first run records them as applied without running them
(`BASELINE` in `migrate.ts`).

```bash
pnpm db:migrate:status   # what is pending on DATABASE_URL (read-only)
pnpm db:migrate:verify   # run it on DATABASE_URL's real data, then roll back
pnpm db:migrate          # apply it now — to whatever DATABASE_URL points at
pnpm db:check            # schema.ts vs these files, on a throwaway local Postgres
```

`drizzle-kit push`, `migrate` and `generate` are gone from package.json. Push
disables RLS and drops the AI role's policies (neither is declared in
schema.ts), `migrate` stops at the old journal (0052), and `generate` diffs
against snapshots frozen at 0035.

## Before a push: the pre-push hook

`.githooks/pre-push` (enabled by `pnpm install`) runs whenever a push touches
`drizzle/*.sql` or `src/database/`:

1. `pnpm db:check`: schema.ts and the migrations must agree.
2. `pnpm db:migrate:verify`: every pending file runs on the real data
   (`DATABASE_URL`) in one transaction that is always rolled back. Duplicate
   rows under a new unique index, NULLs under a new `NOT NULL`, or a bad cast
   stop the push here instead of failing the deploy. Files that build an index
   `CONCURRENTLY` can't run in a transaction, so they are skipped.

If `DATABASE_URL` can't be reached, the hook warns and lets the push through.
`git push --no-verify` skips the hook in an emergency.

## When a deploy's migration fails anyway

The container exits before the server starts, so it never answers
`GET /health` and the Dockerfile `HEALTHCHECK` never turns healthy. With the
health check enabled in Coolify, the previous container keeps serving and the
deploy is marked failed. Fix the migration and push again.

## Adding a migration

1. Change `schema.ts`.
2. Write `drizzle/NNNN_what_it_does.sql` with the next number. Write it by hand:
   `drizzle-kit generate` output is polluted.
3. Make it **idempotent** (`IF NOT EXISTS`, guarded `DO` blocks) and
   **compatible with the code that is still running**. The old server keeps
   serving while the new one migrates, so add a column first and drop the old
   one in a later deploy, never in the same one.
4. Run `pnpm db:check` until it says the two agree.
5. Commit the schema change and the SQL together.

A file runs as **one transaction**, so it applies fully or not at all. A file
that builds an index `CONCURRENTLY` can't run inside a transaction, so it runs
statement by statement instead. The `-- migrate:no-transaction` marker forces
the same mode for any other file. Such a file is not atomic, so it must be safe
to re-run after a partial failure. The runner refuses to record it while it
leaves an INVALID index behind (a failed unique build, usually because of
duplicate rows).

Each statement waits at most 5 s for a table lock (`MIGRATE_LOCK_TIMEOUT`).
Without that limit, an `ALTER TABLE` queued behind a long query would block
every query after it, the till included. A timed-out deploy just fails;
redeploy.
