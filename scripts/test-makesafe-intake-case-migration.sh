#!/usr/bin/env bash
# Apply/re-apply and test the full ordered make-safe production migration set
# against a disposable production-schema clone. This script refuses the live project.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
URL=${MAKESAFE_PROD_SCHEMA_CLONE_URL:-}
ACK=${MAKESAFE_PROD_SCHEMA_CLONE_ACK:-}

if [ -z "$URL" ]; then
  echo "error: set MAKESAFE_PROD_SCHEMA_CLONE_URL to a disposable prod-schema clone" >&2
  exit 2
fi
if [ "$ACK" != "I-confirm-this-is-a-disposable-prod-schema-clone" ]; then
  echo "error: set MAKESAFE_PROD_SCHEMA_CLONE_ACK=I-confirm-this-is-a-disposable-prod-schema-clone" >&2
  exit 2
fi
case "$URL" in
  *kevgrhcjxspbxgovpmfl*|*kevgrhcjxspbxgovpmfl.supabase.co*)
    echo "error: refusing production project kevgrhcjxspbxgovpmfl" >&2
    exit 3
    ;;
esac
command -v psql >/dev/null 2>&1 || {
  echo "error: psql is required" >&2
  exit 2
}

MIGRATIONS="
$ROOT/supabase/migrations/20260717000001_jobs_quoted_value_generated.sql
$ROOT/supabase/migrations/20260720000001_makesafe_intake_cases.sql
$ROOT/supabase/migrations/20260720000002_makesafe_deterministic_intake_cutover.sql
$ROOT/supabase/migrations/20260721000001_makesafe_intake_production_controls.sql
"
CASE_CONTRACT="$ROOT/supabase/tests/makesafe_intake_cases_contract.sql"
CONTROLS_CONTRACT="$ROOT/supabase/tests/makesafe_production_controls_contract.sql"

business_counts() {
  psql "$URL" -X -v ON_ERROR_STOP=1 -Atqc "
    SELECT json_build_array(
      (SELECT count(*) FROM public.jobs),
      (SELECT count(*) FROM public.job_assignments),
      (SELECT count(*) FROM public.work_orders),
      (SELECT count(*) FROM public.xero_invoices),
      (SELECT count(*) FROM public.makesafe_intake_drafts),
      (SELECT count(*) FROM public.job_documents)
    )::text;
  "
}

before_counts=$(business_counts)

# Apply the exact ordered set, then re-apply the same exact ordered set. Every
# migration in a production release must be re-entrant on the disposable clone.
for pass in apply reapply; do
  echo "== ${pass}: ordered production migration set =="
  for migration in $MIGRATIONS; do
    echo "$(basename "$migration")"
    psql "$URL" -X -v ON_ERROR_STOP=1 -1 -f "$migration"
  done
done

after_counts=$(business_counts)
if [ "$before_counts" != "$after_counts" ]; then
  echo "error: ordered migration set changed business side-effect row counts" >&2
  echo "before=$before_counts" >&2
  echo "after=$after_counts" >&2
  exit 4
fi

psql "$URL" -X -v ON_ERROR_STOP=1 -f "$CASE_CONTRACT"
psql "$URL" -X -v ON_ERROR_STOP=1 -f "$CONTROLS_CONTRACT"

echo "make-safe full ordered migration clone contracts passed"
