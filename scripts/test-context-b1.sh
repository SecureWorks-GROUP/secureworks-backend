#!/usr/bin/env bash
# Caller supplies a fresh, local disposable database. Never runs against hosted DBs.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
url=${CONTEXT_B1_TEST_DATABASE_URL:?Set a fresh local disposable PostgreSQL URL}
case "$url" in
 postgresql://*@localhost:*/*|postgresql://*@127.0.0.1:*/*) ;;
 *) echo 'Refusing non-local test database' >&2; exit 2 ;;
esac
psql "$url" -X -v ON_ERROR_STOP=1 -f "$root/supabase/tests/fixtures/context_b1.sql"
for pass in 1 2; do
 for migration in 20260911170000_automation_switches 20260911170001_context_run_ledger; do
  psql "$url" -X -v ON_ERROR_STOP=1 -1 -f "$root/supabase/migrations/$migration.sql"
 done
done
psql "$url" -X -v ON_ERROR_STOP=1 -f "$root/supabase/tests/context_b1_contract.sql"
