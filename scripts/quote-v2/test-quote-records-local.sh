#!/usr/bin/env bash
# Quote v2 stage 2 end-to-end proof on a DISPOSABLE LOCAL Postgres only:
# apply the price book and quote records migrations, freeze the three real
# shapes (Gwelup SWF-261423, SWP-26051, Kiko), then serve the party pages and
# acceptances through the real quote-v2 handler. Sends nothing.
#
#   QUOTE_RECORDS_LOCAL_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
#   QUOTE_RECORDS_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
#   bash scripts/quote-v2/test-quote-records-local.sh [out-dir]
#
# Needs psql and deno. Creates and drops a database named quote_v2_records.
set -euo pipefail

ADMIN_URL=${QUOTE_RECORDS_LOCAL_DATABASE_URL:-}
if [ "${QUOTE_RECORDS_DISPOSABLE_ACK:-}" != "I-confirm-this-is-disposable-local-postgres" ]; then
  echo "error: set QUOTE_RECORDS_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres" >&2
  exit 2
fi
if [[ ! "$ADMIN_URL" =~ ^postgres(ql)?://([^/?#@]+@)?(127\.0\.0\.1|localhost)(:[0-9]+)?/[^/?#]+$ ]]; then
  echo "error: QUOTE_RECORDS_LOCAL_DATABASE_URL must target localhost" >&2
  exit 2
fi

psql_local() (
  unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGPORT PGDATABASE PGUSER
  command psql "$@"
)

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
OUT=${1:-$(mktemp -d)}
DB=quote_v2_records
DB_URL="${ADMIN_URL%/*}/$DB"
psql_local "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
trap 'psql_local "$ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true' EXIT

for case_name in 20260925010000_quote_price_book 20260925020000_quote_v2_records; do
  psql_local "$DB_URL" -X -q -v ON_ERROR_STOP=1 \
    -f "$ROOT/supabase/tests/migration-contracts/$case_name/setup.sql" \
    -f "$ROOT/supabase/migrations/$case_name.sql" 2>&1 | { grep -v 'SET LOCAL' || true; }
done
psql_local "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/scripts/quote-v2/quote_records_proof_fixture.sql"

(cd "$ROOT" && deno run --allow-run=psql --allow-write="$OUT" --allow-env \
  scripts/quote-v2/quote_records_local_proof.ts --db-url "$DB_URL" --out "$OUT")
echo "quote records local proof passed; party pages in $OUT"
