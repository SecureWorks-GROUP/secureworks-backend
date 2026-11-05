#!/usr/bin/env bash
# Focused disposable PostgreSQL proof, including two independent concurrent writers.
set -euo pipefail
if [[ "${1:-}" == '--help' ]]; then
  printf '%s\n' 'usage: INVOICE_REVIEW_TEST_DATABASE_URL=<localhost-admin-url> INVOICE_REVIEW_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres bash scripts/test-invoice-milestone-reviews.sh'
  exit 0
fi
if [[ $# != 0 ]]; then printf '%s\n' 'error: no positional arguments accepted' >&2; exit 2; fi
admin_url=${INVOICE_REVIEW_TEST_DATABASE_URL:-}
if [[ "${INVOICE_REVIEW_DISPOSABLE_ACK:-}" != 'I-confirm-this-is-disposable-local-postgres' ]]; then
  printf '%s\n' 'error: explicit disposable-local acknowledgement required' >&2; exit 2
fi
case "$admin_url" in
  postgresql://*@127.0.0.1:*/postgres|postgresql://*@localhost:*/postgres) ;;
  *) printf '%s\n' 'error: database URL must target localhost /postgres' >&2; exit 2 ;;
esac
command -v psql >/dev/null || { printf '%s\n' 'error: psql required' >&2; exit 2; }
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
case_name=20261105003000_invoice_milestone_review_intents
database="ws6_invoice_review_${BASHPID}"
database_url="${admin_url%/*}/$database"
created=false
cleanup() {
  if [[ "$created" == true ]]; then
    psql "$admin_url" -X -v ON_ERROR_STOP=1 -q -c "DROP DATABASE \"$database\" WITH (FORCE)" >/dev/null
  fi
}
trap cleanup EXIT
psql "$admin_url" -X -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$database\""
created=true
psql "$database_url" -X -v ON_ERROR_STOP=1 -q \
  -f "$repo/supabase/tests/migration-contracts/$case_name/setup.sql" \
  -f "$repo/supabase/migrations/$case_name.sql" \
  -f "$repo/supabase/tests/migration-contracts/$case_name/contract.sql"
psql "$database_url" -X -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('11000000-0000-4000-8000-000000000008','00000000-0000-0000-0000-000000000001','patio','accepted','WS6-REVIEW-CONCURRENT');
SQL
psql "$database_url" -X -v ON_ERROR_STOP=1 -q <<'SQL' &
BEGIN;
INSERT INTO public.job_assignments(id,job_id,scheduled_date,status,assignment_type) VALUES
 ('55000000-0000-4000-8000-000000000008','11000000-0000-4000-8000-000000000008','2026-11-06','scheduled','install');
SELECT pg_sleep(1);
COMMIT;
SQL
first=$!
psql "$database_url" -X -v ON_ERROR_STOP=1 -q <<'SQL' &
BEGIN;
INSERT INTO public.job_assignments(id,job_id,scheduled_date,status,assignment_type) VALUES
 ('55000000-0000-4000-8000-000000000007','11000000-0000-4000-8000-000000000008','2026-11-06','scheduled','install');
COMMIT;
SQL
second=$!
wait "$first"
wait "$second"
psql "$database_url" -X -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM public.invoice_milestone_reviews WHERE job_id='11000000-0000-4000-8000-000000000008') <> 1 THEN
  RAISE EXCEPTION 'concurrent bookings duplicated review'; END IF;
 IF (SELECT count(*) FROM public.job_assignments WHERE job_id='11000000-0000-4000-8000-000000000008') <> 2 THEN
  RAISE EXCEPTION 'concurrent booking lost an assignment'; END IF;
END $$;
SQL
psql "$database_url" -X -v ON_ERROR_STOP=1 -q \
  -f "$repo/supabase/rollbacks/${case_name}_down.sql" \
  -f "$repo/supabase/tests/migration-contracts/$case_name/rollback-contract.sql"
printf '%s\n' 'result: pass' 'proof: migration, replay, concurrent bookings, exact revision, held state, auth grants, atomic failure, rollback'
