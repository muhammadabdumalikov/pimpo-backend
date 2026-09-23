#!/usr/bin/env bash
# Clear duplicate barcodes, then build the unique index — in that order.
#
# Reads DATABASE_URL out of pimpo-backend/.env (or the environment, which wins),
# so nothing has to be exported by hand and the password never reaches shell
# history. Both steps are idempotent: a second run finds nothing to do.
#
#   ./scripts/barkod-unique.sh          # clean up, then create the index
#   ./scripts/barkod-unique.sh --check  # only report duplicates, change nothing
#
# 0076 must NOT go through `drizzle-kit push`: push builds the index without the
# duplicate guard and without CONCURRENTLY, which is what locked the shop out.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cleanup="$root/../tozalash-barkod-dublikat.sql"
migration="$root/drizzle/0076_product_barcode_unique.sql"

# The environment wins; otherwise take the first DATABASE_URL line from .env
# (value as written, unquoted, everything after the first '=').
if [[ -z "${DATABASE_URL:-}" ]]; then
  env_file="$root/.env"
  [[ -f "$env_file" ]] || { echo "DATABASE_URL topilmadi va $env_file yo'q" >&2; exit 1; }
  DATABASE_URL="$(grep -m1 -E '^DATABASE_URL=' "$env_file" | cut -d= -f2-)"
  DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
  DATABASE_URL="${DATABASE_URL%\'}"; DATABASE_URL="${DATABASE_URL#\'}"
fi
[[ -n "$DATABASE_URL" ]] || { echo "DATABASE_URL bo'sh" >&2; exit 1; }
export DATABASE_URL

# Name the server being touched — these scripts are usually pointed at prod.
echo "== Baza =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off \
  -c "select current_database() as db, coalesce(host(inet_server_addr()), 'local') as host;"

echo
echo "== Dublikat shtrix-kodlar =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off -c "
SELECT p.barcode, count(*) AS kartochka, string_agg(left(p.name, 30), ' | ') AS nomlar
  FROM products p
 WHERE p.is_active AND p.barcode IS NOT NULL AND p.barcode <> ''
 GROUP BY p.business_id, p.barcode
HAVING count(*) > 1
 ORDER BY p.barcode;"

if [[ "${1:-}" == "--check" ]]; then
  echo
  echo "--check: hech narsa o'zgartirilmadi."
  exit 0
fi

echo
echo "== 1/2 Tozalash =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off -f "$cleanup"

echo
echo "== 2/2 Unique indeks =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off -f "$migration"

echo
echo "Tayyor. Kodi bo'shatilgan kartochkalar: barcode_dedupe_backup jadvalida."
