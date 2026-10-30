#!/usr/bin/env bash
# Local proof for scripts/int10-five-job-bill-outcomes-acceptance.sql (INT-10):
# that it compares the bills a job card should list with the bills it does list
# in both directions, keeps every picked job, and flags what is wrong by name.
#
# On a disposable localhost PostgreSQL it builds the registered contract stack
# (setup and migration, in timestamp order, as run.sh does), commits the H7
# synthetic fixtures (the CFO case's h7_fixtures.sql: no customer data), then
# runs the acceptance script four ways:
#   honest   the card as the migrations serve it: no failure, every eligible
#            job listed, the unplaced trade-app mirror shown as excluded_mirror;
#   dropped  the card leaves out one expected bill: that bill is
#            missing_from_card, a failure, on its job;
#   extra    the card carries a bill nothing places or counts on the job: it is
#            extra_on_card, a failure;
#   empty    one job's card lists nothing: the job still shows, every expected
#            bill of it missing_from_card;
#   mirror   the card shows the trade-app mirror no person placed: the
#            exclusion does not hide it, it is extra_on_card.
# The three bad cards are made by renaming the real read and wrapping it, in
# this disposable database only. Never point it at anything but a disposable
# database: it drops and recreates its own.
#
# MIGRATION_CONTRACT_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/postgres \
# MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
# bash scripts/test-int10-acceptance-proof.sh
# INT10_PROOF_TEMPLATE_DB=<name of a local database already holding the stack>
# skips the stack build (it is copied instead).
set -euo pipefail
export LC_ALL=C

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
CONTRACT_ROOT="$REPO_ROOT/supabase/tests/migration-contracts"
SCRIPT="$REPO_ROOT/scripts/int10-five-job-bill-outcomes-acceptance.sql"
ADMIN_DATABASE_URL=${MIGRATION_CONTRACT_ADMIN_DATABASE_URL:-}
if [ "${MIGRATION_CONTRACT_DISPOSABLE_ACK:-}" != "I-confirm-this-is-disposable-local-postgres" ]; then
  echo "error: set MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres" >&2; exit 2
fi
case "$ADMIN_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
  *) echo "error: MIGRATION_CONTRACT_ADMIN_DATABASE_URL must target localhost" >&2; exit 2 ;;
esac
DB=secureworks_int10_acceptance_proof
URL="${ADMIN_DATABASE_URL%/*}/$DB"
WORK=$(mktemp -d)
cleanup() {
  psql "$ADMIN_DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
q() { psql "$URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "FAIL: $1" >&2; [ -n "${2:-}" ] && cat "$2" >&2; exit 1; }

if [ -n "${INT10_PROOF_TEMPLATE_DB:-}" ]; then
  echo "== copying $INT10_PROOF_TEMPLATE_DB =="
  psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" \
    -c "CREATE DATABASE \"$DB\" TEMPLATE \"$INT10_PROOF_TEMPLATE_DB\";"
else
  echo "== building $DB from the registered contract stack =="
  psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" -c "CREATE DATABASE \"$DB\";"
  for d in "$CONTRACT_ROOT"/20*; do
    n=$(basename "$d")
    q -f "$d/setup.sql" >/dev/null 2>&1 || { echo "setup failed: $n" >&2; q -f "$d/setup.sql"; exit 1; }
    q -f "$REPO_ROOT/supabase/migrations/$n.sql" >/dev/null 2>&1 || { echo "migration failed: $n" >&2; q -f "$REPO_ROOT/supabase/migrations/$n.sql"; exit 1; }
  done
fi
q -f "$CONTRACT_ROOT/20261029170000_cfo_bill_cost_outcomes/h7_fixtures.sql" >/dev/null

# Runs the acceptance script as written; prints its rows as job|proof|failure|job_failures|...|xero_invoice_id (col 9).
run() { psql "$URL" -X -q -At -F '|' -v ON_ERROR_STOP=1 -f "$SCRIPT" > "$WORK/$1.out" 2>&1 || fail "$1: the script failed" "$WORK/$1.out"; }
show() { echo "-- $1: job | proof | failure | job_failures | xero_invoice_id | expected_because | mirror_exclusion"; awk -F'|' '{ printf "   %s | %s | %s | %s | %s | %s | %s\n", $1, $2, $3, $4, $9, $5, ($6 == "" ? "" : "excluded (named)") }' "$WORK/$1.out"; }
row() { awk -F'|' -v j="$2" -v b="$3" '$1 == j && $9 == b { print $2 "|" $3 }' "$WORK/$1.out"; }
jobs() { cut -d'|' -f1 "$WORK/$1.out" | sort -u | tr '\n' ' '; }

wrap() {
  q -c "CREATE OR REPLACE FUNCTION public.context_job_bill_outcomes(p_job uuid) RETURNS jsonb LANGUAGE sql STABLE AS \$w\$ $1 \$w\$;" \
    -c "GRANT EXECUTE ON FUNCTION public.context_job_bill_outcomes(uuid) TO service_role;"
}

echo "== honest =="
run honest; show honest
want_jobs=$(q -At -c "SELECT string_agg(job_number, ' ' ORDER BY job_number) || ' ' FROM (SELECT j.job_number FROM public.jobs j
  WHERE j.legacy IS NOT TRUE AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true'
    AND (EXISTS (SELECT 1 FROM public.xero_invoices x WHERE x.job_id = j.id AND x.invoice_type = 'ACCPAY')
         OR EXISTS (SELECT 1 FROM public.job_materials_facts f WHERE f.job_id = j.id AND f.kind = 'actual' AND f.xero_invoice_id IS NOT NULL))
  ORDER BY md5('int-10-acceptance-v1:' || j.id::text) LIMIT 5) s")
[ "$(jobs honest)" = "$want_jobs" ] || fail "honest: jobs $(jobs honest), want $want_jobs" "$WORK/honest.out"
grep -q '|t|' <(cut -d'|' -f1-4 "$WORK/honest.out") && fail "honest: a failure on the card as served" "$WORK/honest.out"
[ "$(row honest H7-J1 H7-MIR)" = "excluded_mirror|f" ] || fail "honest: the unplaced mirror is not named excluded" "$WORK/honest.out"
echo "ok: honest has no failure, lists $want_jobs, names the excluded mirror"

q -c "ALTER FUNCTION public.context_job_bill_outcomes(uuid) RENAME TO context_job_bill_outcomes_served;" \
  -c "GRANT EXECUTE ON FUNCTION public.context_job_bill_outcomes_served(uuid) TO service_role;"

echo "== dropped: H7-J1's card leaves out H7-PLAIN =="
wrap "SELECT jsonb_set(r, '{bills}', COALESCE((SELECT jsonb_agg(b) FROM jsonb_array_elements(r -> 'bills') b
        WHERE b ->> 'xero_invoice_id' IS DISTINCT FROM 'H7-PLAIN'), '[]'::jsonb))
      FROM public.context_job_bill_outcomes_served(p_job) r"
run dropped; show dropped
[ "$(row dropped H7-J1 H7-PLAIN)" = "missing_from_card|t" ] || fail "dropped: H7-PLAIN is not flagged missing" "$WORK/dropped.out"
[ "$(grep -c '^[^|]*|[^|]*|t|' "$WORK/dropped.out")" = 1 ] || fail "dropped: more than the one failure" "$WORK/dropped.out"
echo "ok: the dropped bill is missing_from_card, and nothing else fails"

echo "== extra: H7-J2's card carries H7-GHOST =="
wrap "SELECT CASE WHEN p_job = 'c7000000-0000-4000-8000-000000000002' THEN jsonb_set(r, '{bills}', (r -> 'bills') || jsonb_build_array(
        jsonb_build_object('xero_invoice_id', 'H7-GHOST', 'invoice_number', 'B-GHOST', 'where_counted', 'here', 'bill_state', 'counted_in_full',
                           'here', jsonb_build_object('counts', 'counted', 'reason', 'engine_reads_allocation_rows'), 'other_jobs', '[]'::jsonb)))
      ELSE r END FROM public.context_job_bill_outcomes_served(p_job) r"
run extra; show extra
[ "$(row extra H7-J2 H7-GHOST)" = "extra_on_card|t" ] || fail "extra: H7-GHOST is not flagged extra" "$WORK/extra.out"
[ "$(grep -c '^[^|]*|[^|]*|t|' "$WORK/extra.out")" = 1 ] || fail "extra: more than the one failure" "$WORK/extra.out"
echo "ok: the extra bill is extra_on_card, and nothing else fails"

echo "== empty: H7-J3's card lists nothing =="
wrap "SELECT CASE WHEN p_job = 'c7000000-0000-4000-8000-000000000005' THEN jsonb_set(r, '{bills}', '[]'::jsonb) ELSE r END
      FROM public.context_job_bill_outcomes_served(p_job) r"
run empty; show empty
[ "$(jobs empty)" = "$want_jobs" ] || fail "empty: a job was dropped ($(jobs empty))" "$WORK/empty.out"
j3_rows=$(awk -F'|' '$1 == "H7-J3"' "$WORK/empty.out" | wc -l)
j3_missing=$(awk -F'|' '$1 == "H7-J3" && $2 == "missing_from_card" && $3 == "t"' "$WORK/empty.out" | wc -l)
[ "$j3_rows" -gt 0 ] && [ "$j3_rows" = "$j3_missing" ] || fail "empty: H7-J3's expected bills are not all missing" "$WORK/empty.out"
echo "ok: the empty card's job still shows, its $j3_rows expected bills each missing_from_card"

echo "== mirror: H7-J1's card shows the unplaced mirror H7-MIR =="
wrap "SELECT CASE WHEN p_job = 'c7000000-0000-4000-8000-000000000001' THEN jsonb_set(r, '{bills}', (r -> 'bills') || jsonb_build_array(
        jsonb_build_object('xero_invoice_id', 'H7-MIR', 'invoice_number', 'B-H7-MIR', 'where_counted', 'trade_app', 'bill_state', 'trade_mirror',
                           'mirror_bill', true, 'here', jsonb_build_object('counts', 'not_counted', 'reason', 'mirror_bill_not_placed_here'), 'other_jobs', '[]'::jsonb)))
      ELSE r END FROM public.context_job_bill_outcomes_served(p_job) r"
run mirror
[ "$(row mirror H7-J1 H7-MIR)" = "extra_on_card|t" ] || fail "mirror: the excluded mirror on the card is not flagged extra" "$WORK/mirror.out"
[ "$(grep -c '^[^|]*|[^|]*|t|' "$WORK/mirror.out")" = 1 ] || fail "mirror: more than the one failure" "$WORK/mirror.out"
echo "ok: an excluded mirror the card shows is extra_on_card"

echo "INT-10 acceptance proof passed"
