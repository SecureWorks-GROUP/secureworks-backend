#!/usr/bin/env bash
# Quote v2 stage 1 end-to-end proof on a DISPOSABLE LOCAL Postgres only:
# apply the price book migration, run the ten-store import twice (the second
# run must add nothing), then read the current prices back.
#
#   PRICE_BOOK_LOCAL_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
#   PRICE_BOOK_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
#   bash scripts/quote-v2/test-price-book-local.sh
#
# Needs psql, deno and read access to ~/Projects/{fence-designer,patio-tool,
# secureworks-wiki}. Creates and drops a database named quote_v2_price_book.
set -euo pipefail

ADMIN_URL=${PRICE_BOOK_LOCAL_DATABASE_URL:-}
if [ "${PRICE_BOOK_DISPOSABLE_ACK:-}" != "I-confirm-this-is-disposable-local-postgres" ]; then
  echo "error: set PRICE_BOOK_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres" >&2
  exit 2
fi
case "$ADMIN_URL" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
  *) echo "error: PRICE_BOOK_LOCAL_DATABASE_URL must target localhost" >&2; exit 2 ;;
esac

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
DB=quote_v2_price_book
DB_URL="${ADMIN_URL%/*}/$DB"
psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
trap 'psql "$ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true' EXIT

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/tests/migration-contracts/20260925010000_quote_price_book/setup.sql" \
  -f "$ROOT/supabase/migrations/20260925010000_quote_price_book.sql" 2>&1 | grep -v "SET LOCAL" || true

count() {
  psql "$DB_URL" -X -tA -c "select (select count(*) from price_book_items) || '/' || (select count(*) from price_book_costs) || '/' || (select count(*) from price_book_stock_lengths) || '/' || (select count(*) from price_book_cut_rules) || '/' || (select count(*) from price_book_allowances)"
}

run_import() {
  (cd "$ROOT" && deno run --allow-read --allow-write --allow-env=HOME --allow-run=git,psql \
    scripts/quote-v2/price_book_import.ts --apply --db-url "$DB_URL" >/dev/null)
}

run_import
first=$(count)
run_import
second=$(count)
echo "items/costs/stock/cut/allowances after run 1: $first, after run 2: $second"
[ "$first" = "$second" ] || { echo "error: the second import added rows" >&2; exit 1; }

zero=$(psql "$DB_URL" -X -tA -c "select count(*) from price_book_costs where cost_ex_gst <= 0")
blessed=$(psql "$DB_URL" -X -tA -c "select count(*) from price_book_costs where not provisional")
[ "$zero" = "0" ] || { echo "error: a zero cost was loaded" >&2; exit 1; }
[ "$blessed" = "0" ] || { echo "error: the import blessed a row" >&2; exit 1; }

psql "$DB_URL" -X -c "select status, count(*) from price_book_current_costs() group by 1 order by 1"
psql "$DB_URL" -X -c "select item_key, status, cost_ex_gst, per_length_mm, supplier, as_at, evidence_kind, stock_lengths_mm, cut_rule from price_book_current_costs(array['steel-rhs-100x50x2','stratco-qs-slat-65-col-lm','fence-panel-kit-h1800-w2380-post2400','fence-delivery-rr','concrete-kwikset-20kg'])"
psql "$DB_URL" -X -c "select family, value, status from price_book_current_markup('patio') union all select family, value, status from price_book_current_markup('fencing')"
echo "price book local proof passed"
