#!/usr/bin/env bash
# pnpm db:check — prove schema.ts and drizzle/*.sql describe the same database.
#
# schema.ts is the single source of truth; the migrations are how a database
# gets there. This builds two throwaway databases on a private local Postgres:
#   1. every migration, applied by the real runner (src/database/migrate.ts)
#   2. the full DDL drizzle-kit generates from schema.ts
# and diffs their indexes (full definition: WHERE, opclass, DESC, expressions),
# columns and constraints. Any difference fails the check — except a column
# listed in drizzle/pending-drops.txt, see below.
#
# Needs initdb / pg_ctl / psql on PATH (brew install postgresql). Touches no
# shared database: DATABASE_URL and .env are ignored.
set -euo pipefail

for bin in initdb pg_ctl psql; do
  command -v "$bin" >/dev/null || { echo "db:check needs '$bin' on PATH (brew install postgresql)"; exit 2; }
done

BE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
PORT=$((55400 + RANDOM % 100))
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -q -v ON_ERROR_STOP=1)

cleanup() {
  pg_ctl -D "$TMP/pg" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

initdb -D "$TMP/pg" -U postgres >/dev/null 2>&1
pg_ctl -D "$TMP/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" \
  -l "$TMP/pg.log" -w start >/dev/null
"${PSQL[@]}" -d postgres -c "CREATE DATABASE migrations" -c "CREATE DATABASE fromschema"

echo "· applying drizzle/*.sql with the migration runner"
(cd "$BE" && env -u DATABASE_URL DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/migrations" \
  ./node_modules/.bin/ts-node --transpile-only src/database/migrate.ts | tail -1)

echo "· generating the DDL of schema.ts"
cat > "$TMP/drizzle.config.ts" <<EOF
export default {
  schema: '$BE/src/database/schema.ts',
  dialect: 'postgresql',
  out: '$TMP/gen',
};
EOF
(cd "$BE" && ./node_modules/.bin/drizzle-kit generate --config="$TMP/drizzle.config.ts" --name=full \
  </dev/null >"$TMP/generate.log" 2>&1) || { cat "$TMP/generate.log"; exit 1; }
# Extensions live in migrations, not in schema.ts.
"${PSQL[@]}" -d fromschema -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
sed 's/--> statement-breakpoint//g' "$TMP"/gen/*.sql | "${PSQL[@]}" -d fromschema >/dev/null

INDEXES="SELECT tablename || ' | ' || regexp_replace(indexdef, ' ON public\\.', ' ON ')
           FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1"
COLUMNS="SELECT table_name || '.' || column_name || ' ' || data_type
           || coalesce('(' || character_maximum_length || ')', '')
           || coalesce(' p' || numeric_precision || ',' || numeric_scale, '')
           || ' null=' || is_nullable || ' default=' || coalesce(column_default, '-')
           FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1"
CONSTRAINTS="SELECT conrelid::regclass || ' | ' || conname || ' | ' || pg_get_constraintdef(oid)
           FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1"

drift=0

# drizzle/pending-drops.txt: columns still in the database but already gone
# from schema.ts and the code, because a later deploy drops them (README.md,
# "Dropping a column"). Only those, and only on the migrations side, are
# ignored — and only while each really is in the migrated database and really
# is gone from schema.ts, so a stale line cannot outlive its DROP.
PENDING="$TMP/pending"
{ sed -e 's/#.*//' -e 's/[[:space:]]//g' "$BE/drizzle/pending-drops.txt" 2>/dev/null || true; } \
  | { grep -v '^$' || true; } | sort -u >"$PENDING"
while IFS= read -r col; do
  if [[ ! "$col" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]]; then
    drift=1; echo; echo "✗ pending-drops.txt: '$col' is not table.column"; continue
  fi
  q="SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = '${col%%.*}' AND column_name = '${col#*.}'"
  if [[ "$("${PSQL[@]}" -d migrations -At -c "$q")" != 1 ]]; then
    drift=1; echo; echo "✗ pending-drops.txt: $col is not in the migrated database — dropped already? Remove the line."
  fi
  if [[ "$("${PSQL[@]}" -d fromschema -At -c "$q")" != 0 ]]; then
    drift=1; echo; echo "✗ pending-drops.txt: $col is still declared in schema.ts"
  fi
done <"$PENDING"

for kind in INDEXES COLUMNS CONSTRAINTS; do
  for db in migrations fromschema; do
    "${PSQL[@]}" -d "$db" -At -c "${!kind}" >"$TMP/$kind.$db"
  done
  if [[ $kind == COLUMNS && -s "$PENDING" ]]; then
    # Each line starts "table.column "; drop the pending ones.
    awk 'NR == FNR { skip[$0] = 1; next } !(substr($0, 1, index($0, " ") - 1) in skip)' \
      "$PENDING" "$TMP/COLUMNS.migrations" >"$TMP/COLUMNS.kept"
    mv "$TMP/COLUMNS.kept" "$TMP/COLUMNS.migrations"
  fi
  only_mig="$(comm -23 "$TMP/$kind.migrations" "$TMP/$kind.fromschema")"
  only_schema="$(comm -13 "$TMP/$kind.migrations" "$TMP/$kind.fromschema")"
  if [[ -n "$only_mig$only_schema" ]]; then
    drift=1
    echo
    echo "✗ $kind differ"
    [[ -n "$only_mig" ]] && printf '  only in the migrations:\n%s\n' "$(sed 's/^/    /' <<<"$only_mig")"
    [[ -n "$only_schema" ]] && printf '  only in schema.ts:\n%s\n' "$(sed 's/^/    /' <<<"$only_schema")"
  fi
done

if [[ $drift -eq 0 ]]; then
  echo "✓ schema.ts and drizzle/*.sql agree (indexes, columns, constraints)"
else
  echo
  echo "Fix schema.ts or add a migration until they agree."
  exit 1
fi
