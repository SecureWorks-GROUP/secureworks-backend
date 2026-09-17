#!/usr/bin/env bash
# Caller supplies a fresh, local disposable database. Never runs against hosted DBs.
# Proves the B3 forward migrations (custody + budget scope) plus the
# event_at/occurred_at coalesce follow-up apply on top of the ledgered B1/B2
# stack and are safe to re-apply, then runs the B1 and B3 contracts.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
url=${CONTEXT_B3_TEST_DATABASE_URL:?Set a fresh local disposable PostgreSQL URL}
case "$url" in
 postgresql://*@localhost:*/*|postgresql://*@127.0.0.1:*/*) ;;
 *) echo 'Refusing non-local test database' >&2; exit 2 ;;
esac
psql "$url" -X -v ON_ERROR_STOP=1 -f "$root/supabase/tests/fixtures/context_b3.sql"
for migration in 20260911170000_automation_switches 20260911170001_context_run_ledger; do
 psql "$url" -X -v ON_ERROR_STOP=1 -1 -f "$root/supabase/migrations/$migration.sql"
done
# The production current-facts view and five-argument RPC predate B3; B3 must replace that exact view shape.
psql "$url" -X -v ON_ERROR_STOP=1 -1 -f "$root/supabase/migrations/20260910112833_luna_context_source_revisions.sql"
psql "$url" -X -v ON_ERROR_STOP=1 -1 -f "$root/supabase/migrations/20260911171000_context_capture_attribution.sql"
psql "$url" -X -v ON_ERROR_STOP=1 -1 -f "$root/supabase/migrations/20260914110000_context_capture_stamp_and_rerun.sql"
# B3 plus the coalesce follow-up are applied twice: production may be re-applied by the deploy lane.
for _pass in 1 2; do
 for migration in 20260916120000_context_job_fact_custody 20260916120100_context_extraction_budget_scope 20260917120000_luna_context_event_at_coalesce; do
  psql "$url" -X -v ON_ERROR_STOP=1 -1 -f "$root/supabase/migrations/$migration.sql"
 done
done
psql "$url" -X -v ON_ERROR_STOP=1 -f "$root/supabase/tests/context_b1_contract.sql"
psql "$url" -X -v ON_ERROR_STOP=1 -f "$root/supabase/tests/context_b3_contract.sql"
