#!/usr/bin/env bash
# Local behaviour test for the switch checks (Follow-up 56). Disposable
# localhost Postgres only. It copies a template database that already holds
# every registered migration (the migration contract runner's stack), seeds
# fixtures/local-ready.sql, then runs each check against the ready state and
# against one mutation per check that must turn it to FAIL. The director's
# ZZTEST database is never touched by this file.
#   PROOF_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/postgres
#   PROOF_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres
#   PROOF_TEMPLATE_DATABASE=<database holding the full registered stack>
set -euo pipefail
export LC_ALL=C
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
ADMIN=${PROOF_ADMIN_DATABASE_URL:-}
ACK=${PROOF_DISPOSABLE_ACK:-}
TEMPLATE=${PROOF_TEMPLATE_DATABASE:-}
[ "$ACK" = "I-confirm-this-is-disposable-local-postgres" ] || { echo "error: set PROOF_DISPOSABLE_ACK" >&2; exit 2; }
case "$ADMIN" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
  *) echo "error: PROOF_ADMIN_DATABASE_URL must target localhost" >&2; exit 2 ;;
esac
[ -n "$TEMPLATE" ] || { echo "error: set PROOF_TEMPLATE_DATABASE" >&2; exit 2; }
url() { printf '%s/%s' "${ADMIN%/*}" "$1"; }
READY=zz_switch_checks_ready
CASE=zz_switch_checks_case
admin() { psql "$ADMIN" -X -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }
drop() { admin "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE);"; }
copy() { drop "$2"; admin "CREATE DATABASE \"$2\" TEMPLATE \"$1\";"; }
trap 'drop "$CASE" || true; drop "$READY" || true' EXIT

copy "$TEMPLATE" "$READY"
psql "$(url "$READY")" -X -q -v ON_ERROR_STOP=1 -f "$HERE/fixtures/local-ready.sql" >/dev/null
CHANGED_AT=$(psql "$(url "$READY")" -X -q -At -c \
  "SELECT max(marked_at) FROM public.job_change_mark_events m JOIN public.jobs j ON j.id = m.job_id
   WHERE j.job_number = 'ZZTEST-PROOF-1' AND m.source = 'payment'")

failures=0
runs=0
# check <database> <file> <PASS|FAIL|ANY> <label> [extra psql args...]
check() {
  local db=$1 file=$2 want=$3 label=$4; shift 4
  local out got
  out=$(psql "$(url "$db")" -X -q -At -F '|' -v job_number=ZZTEST-PROOF-1 "$@" -f "$HERE/$file" 2>&1) || true
  got=$(printf '%s\n' "$out" | tail -1 | cut -d'|' -f2)
  runs=$((runs + 1))
  # Exactly one row, so a guard's FAIL can never be followed by a PASS.
  [ "$(printf '%s\n' "$out" | grep -c .)" -eq 1 ] || got="more than one row"
  if [ "$want" = ANY ] && { [ "$got" = PASS ] || [ "$got" = FAIL ]; }; then
    echo "ok   [$label] $file -> $got"
  elif [ "$got" = "$want" ]; then
    echo "ok   [$label] $file -> $got"
  else
    failures=$((failures + 1))
    echo "FAIL [$label] $file wanted $want, got: $out"
  fi
  printf '     %s\n' "$(printf '%s\n' "$out" | tail -1)"
}
# mutate <sql> then run one check in a fresh copy of the ready state.
mutated() {
  local sql=$1; shift
  copy "$READY" "$CASE"
  psql "$(url "$CASE")" -X -q -v ON_ERROR_STOP=1 -c "$sql" >/dev/null
  check "$CASE" "$@"
}

echo "== ready state"
for f in 01-switch-off 02-refresh-on 03-refresh-timer 04-source-triggers 05-installed 06-armed \
         07-nothing-waiting 08-stored-equals-live 09-compare-clean; do
  check "$READY" "stored-reader/$f.sql" PASS ready
done
check "$READY" stored-reader/10-change-waiting.sql FAIL "ready: nothing waiting"
check "$READY" stored-reader/11-change-folded.sql PASS ready -v changed_at="$CHANGED_AT"
check "$READY" stored-reader/11-change-folded.sql FAIL "no changed_at"
check "$READY" stored-reader/12-faster.sql ANY "timing only"
for f in 01-switch-off 02-register-table 03-register-access 04-register-empty 05-account-rules \
         06-rules-confirmed 07-division-options 08-raise-kind; do
  check "$READY" "draft-register/$f.sql" PASS ready
done
check "$READY" draft-register/09-raise-door.sql FAIL "no named door on main"
check "$READY" draft-register/10-first-draft-readback.sql FAIL "no draft yet" -v xero_document_id=ZZTEST-DOC-1

echo "== guards"
check "$READY" stored-reader/01-switch-off.sql FAIL "not a ZZTEST job" -v job_number=MB-2
check "$READY" draft-register/04-register-empty.sql FAIL "not a ZZTEST job" -v job_number=MB-2
out=$(psql "$(url "$READY")" -X -q -At -F '|' -f "$HERE/stored-reader/01-switch-off.sql" 2>&1) || true
runs=$((runs + 1))
case "$out" in
  *'|FAIL|'*'job_number not given'*) [ "$(printf '%s\n' "$out" | grep -c .)" -eq 1 ] && echo "ok   [no job_number] guard -> FAIL" || { failures=$((failures + 1)); echo "FAIL [no job_number] more than one row: $out"; } ;;
  *) failures=$((failures + 1)); echo "FAIL [no job_number] guard did not refuse: $out" ;;
esac
mutated "DROP ROLE IF EXISTS zz_plain; CREATE ROLE zz_plain LOGIN; GRANT USAGE ON SCHEMA public TO zz_plain; GRANT SELECT ON public.jobs, public.feature_flags TO zz_plain;" \
  stored-reader/01-switch-off.sql PASS "setup for plain role"
out=$(psql "$(printf '%s' "$(url "$CASE")" | sed 's#//[^@]*@#//zz_plain@#')" -X -q -At -F '|' -v job_number=ZZTEST-PROOF-1 \
  -f "$HERE/stored-reader/07-nothing-waiting.sql" 2>&1 | tail -1) || true
runs=$((runs + 1))
case "$out" in
  *'|FAIL|'*'cannot see rows'*) echo "ok   [plain role] guard -> FAIL"; printf '     %s\n' "$out" ;;
  *) failures=$((failures + 1)); echo "FAIL [plain role] guard did not refuse: $out" ;;
esac
psql "$(url "$CASE")" -X -q -c "DROP OWNED BY zz_plain; DROP ROLE zz_plain;" >/dev/null 2>&1 || true

echo "== one mutation per check"
mutated "UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_story_stored_profit_v1';" \
  stored-reader/01-switch-off.sql FAIL "story switch on"
mutated "UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_profit_refresh_v1';" \
  stored-reader/02-refresh-on.sql FAIL "refresh off"
mutated "UPDATE cron.job SET active = false WHERE jobname = 'job-profit-refresh-marked';" \
  stored-reader/03-refresh-timer.sql FAIL "timer inactive"
mutated "UPDATE cron.job_run_details SET end_time = now() - interval '1 hour';" \
  stored-reader/03-refresh-timer.sql FAIL "timer not run lately"
mutated "ALTER TABLE public.purchase_orders DISABLE TRIGGER job_profit_changed;" \
  stored-reader/04-source-triggers.sql FAIL "one trigger disabled"
mutated "ALTER TABLE public.purchase_orders DISABLE TRIGGER job_profit_changed;" \
  stored-reader/06-armed.sql FAIL "trigger set changed since arm"
mutated "DROP TRIGGER job_story_stored_profit_counts ON public.job_profit_stored;" \
  stored-reader/05-installed.sql FAIL "counts trigger gone"
mutated "DELETE FROM public.job_story_stored_profit_arm WHERE singleton;" \
  stored-reader/06-armed.sql FAIL "not armed"
mutated "SELECT public.job_mark_changed(id, 'payment') FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1';" \
  stored-reader/07-nothing-waiting.sql FAIL "newer real mark"
mutated "SELECT public.job_mark_changed(id, 'payment') FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1';" \
  stored-reader/08-stored-equals-live.sql FAIL "newer real mark"
mutated "SELECT public.job_mark_changed(id, 'payment') FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1';" \
  stored-reader/10-change-waiting.sql PASS "change waiting"
mutated "SELECT public.job_profit_mark(id, 'office') FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1';" \
  stored-reader/07-nothing-waiting.sql FAIL "dirty row"
mutated "UPDATE public.job_profit_stored SET computed_at = computed_at - interval '1 second' WHERE job_id = (SELECT id FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1');" \
  stored-reader/08-stored-equals-live.sql FAIL "summary not its refresh's"
mutated "ALTER TABLE public.job_profit_stored DISABLE TRIGGER USER; UPDATE public.job_profit_stored SET job_number = 'ZZTEST-OTHER' WHERE job_id = (SELECT id FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1'); ALTER TABLE public.job_profit_stored ENABLE TRIGGER USER;" \
  stored-reader/09-compare-clean.sql FAIL "stored row differs from the view"
check "$READY" stored-reader/11-change-folded.sql FAIL "change after the refresh" -v changed_at="$(date -u '+%Y-%m-%d %H:%M:%S+00')"
mutated "UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'xero_draft_standard_v1';" \
  draft-register/01-switch-off.sql FAIL "draft switch on"
mutated "ALTER TABLE public.xero_draft_register DROP COLUMN problems;" \
  draft-register/02-register-table.sql FAIL "column gone"
mutated "GRANT SELECT ON public.xero_draft_register TO authenticated;" \
  draft-register/03-register-access.sql FAIL "browser can read"
mutated "GRANT TRUNCATE ON public.xero_draft_register TO anon;" \
  draft-register/03-register-access.sql FAIL "browser can truncate"
mutated "INSERT INTO public.xero_draft_register(org_id, xero_document_id, document_type, source_kind, register_row, lines_fingerprint, has_account_codes, has_division_tags, has_job_reference, has_source_document) VALUES ('00000000-0000-0000-0000-000000000001', 'ZZTEST-DOC-0', 'ACCPAY', 'trade_invoice', 'X6', repeat('a', 64), true, true, true, true);" \
  draft-register/04-register-empty.sql FAIL "row written while off"
mutated "DELETE FROM public.xero_account_rules WHERE org_id = '00000000-0000-0000-0000-000000000001' AND source_kind = 'supplier_credit';" \
  draft-register/05-account-rules.sql FAIL "supplier credit rule gone"
mutated "UPDATE public.xero_account_rules SET confirmed_at = NULL WHERE source_kind = 'supplier_bill';" \
  draft-register/06-rules-confirmed.sql FAIL "rule not confirmed"
mutated "UPDATE public.xero_tracking_options SET status = 'ARCHIVED' WHERE option_name = 'SW - DECKING';" \
  draft-register/07-division-options.sql FAIL "division archived"
mutated "UPDATE public.xero_tracking_options SET synced_at = now() - interval '3 days';" \
  draft-register/07-division-options.sql FAIL "options stale"
mutated "DELETE FROM public.reconcile_item_kinds WHERE kind = 'draft_incomplete';" \
  draft-register/08-raise-kind.sql FAIL "kind gone"
NAMED="CREATE FUNCTION public.reconcile_item_raise_named(p_kind text, p_subject_table text, p_subject_id text, p_job_ids uuid[], p_suggestion jsonb, p_evidence jsonb, p_raised_by text, p_org_id uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; REVOKE ALL ON FUNCTION public.reconcile_item_raise_named(text, text, text, uuid[], jsonb, jsonb, text, uuid) FROM PUBLIC, anon, authenticated"
mutated "$NAMED; GRANT EXECUTE ON FUNCTION public.reconcile_item_raise_named(text, text, text, uuid[], jsonb, jsonb, text, uuid) TO service_role;" \
  draft-register/09-raise-door.sql PASS "named door as in PR 1643"
mutated "$NAMED; GRANT EXECUTE ON FUNCTION public.reconcile_item_raise_named(text, text, text, uuid[], jsonb, jsonb, text, uuid) TO service_role, authenticated;" \
  draft-register/09-raise-door.sql FAIL "door open to authenticated"
mutated "CREATE FUNCTION public.reconcile_item_raise_named(text, text, text, uuid[], jsonb, jsonb, text, uuid) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; GRANT EXECUTE ON FUNCTION public.reconcile_item_raise_named(text, text, text, uuid[], jsonb, jsonb, text, uuid) TO service_role;" \
  draft-register/09-raise-door.sql FAIL "unnamed parameters"

echo "== first draft readback"
REG="INSERT INTO public.xero_draft_register(org_id, xero_document_id, document_type, source_kind, register_row, job_ids, lines_fingerprint, has_account_codes, has_division_tags, has_job_reference, has_source_document, problems) SELECT '00000000-0000-0000-0000-000000000001', 'ZZTEST-DOC-1'"
JOB="ARRAY[(SELECT id FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1')]"
mutated "$REG, 'ACCPAY', 'trade_invoice', 'X6', $JOB, repeat('a', 64), true, true, true, true, '[]';" \
  draft-register/10-first-draft-readback.sql PASS "clean trade bill" -v xero_document_id=ZZTEST-DOC-1
mutated "$REG, 'ACCPAY', 'supplier_bill', 'X9', $JOB, repeat('a', 64), true, false, true, true, '[{\"code\":\"division_not_known\"}]';" \
  draft-register/10-first-draft-readback.sql FAIL "office draft with a problem, no item" -v xero_document_id=ZZTEST-DOC-1
mutated "$REG, 'ACCPAY', 'supplier_bill', 'X9', $JOB, repeat('a', 64), true, false, true, true, '[{\"code\":\"division_not_known\"}]'; INSERT INTO public.reconcile_items(org_id, kind, subject_table, subject_id, job_ids, reason, evidence_hash, raised_by) VALUES ('00000000-0000-0000-0000-000000000001', 'draft_incomplete', 'xero_draft_register', 'ZZTEST-DOC-1', '{}', 'draft_incomplete', 'zz', 'phase3:books');" \
  draft-register/10-first-draft-readback.sql PASS "office draft with its item" -v xero_document_id=ZZTEST-DOC-1
mutated "$REG, 'ACCPAY', 'trade_invoice', 'X6', $JOB, repeat('a', 64), true, true, true, true, '[{\"code\":\"account_code_missing\"}]';" \
  draft-register/10-first-draft-readback.sql FAIL "flag disagrees with problems" -v xero_document_id=ZZTEST-DOC-1
mutated "$REG, 'ACCREC', 'trade_invoice', 'X6', '{}', repeat('a', 64), true, true, true, true, '[]';" \
  draft-register/10-first-draft-readback.sql FAIL "wrong type, no job" -v xero_document_id=ZZTEST-DOC-1

echo "== $runs runs, $failures not as expected"
[ "$failures" -eq 0 ]
