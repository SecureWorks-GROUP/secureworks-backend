#!/usr/bin/env bash
# Local proof for cap-switch-preconditions.sql and pay-run-switch-preconditions.sql.
# Disposable localhost Postgres only (same guard as the migration contracts).
# Builds the registered migration stack, runs both scripts on the bare stack
# (expected FAIL rows), fills every precondition with test-only fixtures and
# stand-ins, runs them again (expected PASS), and proves the scripts write
# nothing and survive a missing settings table or ledger.
set -euo pipefail
export LC_ALL=C

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
CASES="$ROOT/supabase/tests/migration-contracts"
ADMIN=${MIGRATION_CONTRACT_ADMIN_DATABASE_URL:-}
if [ "${MIGRATION_CONTRACT_DISPOSABLE_ACK:-}" != "I-confirm-this-is-disposable-local-postgres" ]; then
  echo "error: set MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres" >&2
  exit 2
fi
case "$ADMIN" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
  *) echo "error: MIGRATION_CONTRACT_ADMIN_DATABASE_URL must target localhost" >&2; exit 2 ;;
esac

DB=proof_switch_preconditions
URL="${ADMIN%/*}/$DB"
JOB=ZZTEST-PROOF-SWITCH
admin() { psql "$ADMIN" -X -q -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -c "$1" >/dev/null; }
cleanup() { admin "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" || true; }
trap cleanup EXIT
cleanup
admin "CREATE DATABASE \"$DB\";"

echo "== building the registered migration stack"
for case_directory in "$CASES"/20*; do
  name=$(basename "$case_directory")
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -f "$case_directory/setup.sql" >/dev/null
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/$name.sql" >/dev/null
done

# Read-only session: any write inside a script would fail the run.
run_script() {
  PGOPTIONS="-c default_transaction_read_only=on" psql "$URL" -X -q -v ON_ERROR_STOP=1 \
    -v job_number="$JOB" -A -t -F '|' -f "$ROOT/scripts/proof/$1"
}
state_digest() {
  psql "$URL" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT md5(
    coalesce((SELECT string_agg(flag_name || enabled::text, ',' ORDER BY flag_name) FROM public.feature_flags), '')
    || coalesce((SELECT string_agg(t::text, ',') FROM public.trade_pay_settings t), ''))"
}
failures=0
# Keep each run's rows when PROOF_EVIDENCE_DIR names a folder outside git.
save() { if [ -n "${PROOF_EVIDENCE_DIR:-}" ]; then printf '%s\n' "$2" > "$PROOF_EVIDENCE_DIR/$1"; fi; }
expect() { # output, check id prefix, expected result
  local got
  got=$(printf '%s\n' "$1" | awk -F'|' -v id="$2" 'index($3, id) == 1 { print $4 }')
  if [ "$got" != "$3" ]; then
    echo "FAIL: $2 expected $3, got '${got:-<missing row>}'" >&2
    failures=$((failures + 1))
  else
    echo "ok: $2 $3"
  fi
}
expect_overall() {
  local got
  got=$(printf '%s\n' "$1" | awk -F'|' '$2 == "overall" { print $4 }')
  if [ "$got" != "$2" ]; then
    echo "FAIL: overall expected $2, got '${got:-<missing row>}'" >&2
    failures=$((failures + 1))
  else
    echo "ok: overall $2"
  fi
}

echo "== bare stack"
before=$(state_digest)
cap=$(run_script cap-switch-preconditions.sql)
pay=$(run_script pay-run-switch-preconditions.sql)
[ "$(state_digest)" = "$before" ] || { echo "FAIL: a script changed state" >&2; failures=$((failures + 1)); }
save cap-bare.txt "$cap"
save pay-bare.txt "$pay"
for id in C01 C04 C05 C09; do expect "$cap" "$id" PASS; done
# No repository migration gives trade_invoice_lines an org_id, so a
# pay_line_held raise cannot resolve its organisation (C11).
for id in C02 C03 C06 C07 C08 C10 C11 C13 C14 C15 F01 F02 F03; do expect "$cap" "$id" FAIL; done
for id in C12 N01 N02 N03; do expect "$cap" "$id" "NOT CHECKED HERE"; done
expect_overall "$cap" FAIL
for id in P01 P02 P03 P04 P07; do expect "$pay" "$id" PASS; done
for id in P05 P06 P08 P09 P15 F01; do expect "$pay" "$id" FAIL; done
for id in N01 N02 N03 N04 N05 N06; do expect "$pay" "$id" "NOT CHECKED HERE"; done
expect_overall "$pay" FAIL

echo "== filling every precondition (test-only fixtures and stand-ins)"
psql "$URL" -X -q -v ON_ERROR_STOP=1 -v job_number="$JOB" <<'SQL' >/dev/null
SET session_replication_role = replica;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'trade_pay_inclusive_super_v1';
INSERT INTO public.users(id, org_id, name, role)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'ZZTEST Approver', 'admin');
-- Test only: the start date is written straight in, never the live way
-- (set_work_order_cap_start, a signed-in approver).
UPDATE public.work_order_cap_settings SET cap_start_on = '2026-11-16' WHERE id = 1;
UPDATE public.trade_pay_settings
  SET inclusive_super_from = date_trunc('week', (now() AT TIME ZONE 'Australia/Perth'))::date - 7,
      pay_run_approver_user_ids = ARRAY['00000000-0000-0000-0000-0000000000a1']::uuid[]
  WHERE id = 1;
INSERT INTO public.jobs(id, org_id, job_number, type, status)
  VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', :'job_number', 'fencing', 'accepted');
INSERT INTO public.work_orders(id, org_id, job_id, wo_number, kind, status, agreed_labour_ex, approved_at, approved_by, sealed_content_hash)
  VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1',
    'ZZTEST-PROOF-SWITCH-JOB', 'job', 'approved', 10, now(), '00000000-0000-0000-0000-0000000000a1', 'ZZTEST');
SET session_replication_role = origin;
SELECT public.install_trade_line_hold();
SELECT public.install_trade_line_job_amount_guard();
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY, name text);
INSERT INTO supabase_migrations.schema_migrations(version)
  SELECT v FROM unnest(ARRAY['20261117020000','20261117172401','20261117173901','20261117174103',
    '20261118043357','20261118060051','20261118063223','20261118070639','20261118073218',
    '20261118115852','20261118122207','20261118122208','20261118122209','20261118153101']) v;
-- A ZZTEST held line, as a held send leaves it.
SET session_replication_role = replica;
INSERT INTO public.trade_invoices(id, org_id, invoice_kind, status, invoice_number)
  VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'held', 'pending_ops_review', 'ZZTEST-PROOF-H1');
INSERT INTO public.trade_invoice_lines(id, trade_invoice_id, job_id, line_type, line_total_ex, hold_reason, office_review_status)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1',
    'materials', 10, 'no_work_order', 'awaiting');
SET session_replication_role = origin;
-- Stand-in for #1643's named door (exact signature), then the raise a held
-- send makes through it with the holding invoice's organisation (#1649).
CREATE FUNCTION public.reconcile_item_raise_named(p_kind text, p_subject_table text, p_subject_id text,
  p_job_ids uuid[], p_suggestion jsonb, p_evidence jsonb, p_raised_by text, p_org_id uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE sql AS
  'SELECT public.reconcile_item_raise(p_kind, p_subject_table, p_subject_id, p_job_ids, p_suggestion, p_evidence, p_raised_by, p_org_id)';
REVOKE ALL ON FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid) TO service_role;
SELECT public.reconcile_item_raise_named(p_kind => 'pay_line_held', p_subject_table => 'trade_invoice_lines',
  p_subject_id => '00000000-0000-0000-0000-0000000000e1', p_job_ids => ARRAY['00000000-0000-0000-0000-0000000000b1']::uuid[],
  p_suggestion => '{}'::jsonb, p_evidence => '{"reason":"no_work_order","amount_ex":10}'::jsonb,
  p_raised_by => 'phase1:work_order_gate', p_org_id => '00000000-0000-0000-0000-000000000001');
-- Stand-in for the held-line decision (P1-05.10).
CREATE FUNCTION public.decide_held_trade_line(p_line_id uuid, p_decision text, p_actor uuid, p_org_id uuid, p_changes jsonb, p_reason text)
  RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
REVOKE ALL ON FUNCTION public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)
  TO service_role;
CREATE TABLE public.trade_pay_run_weeks(id text PRIMARY KEY, org_id uuid NOT NULL);
SQL

echo "== every precondition filled"
before=$(state_digest)
cap=$(run_script cap-switch-preconditions.sql)
pay=$(run_script pay-run-switch-preconditions.sql)
[ "$(state_digest)" = "$before" ] || { echo "FAIL: a script changed state" >&2; failures=$((failures + 1)); }
save cap-filled.txt "$cap"
save pay-filled.txt "$pay"
for id in C01 C02 C03 C04 C05 C06 C07 C08 C09 C10 C11 C13 C14 C15 F01 F02 F03; do expect "$cap" "$id" PASS; done
expect "$cap" C12 "NOT CHECKED HERE"
expect_overall "$cap" PASS
for id in P01 P02 P03 P04 P05 P06 P07 P08 P09 F01; do expect "$pay" "$id" PASS; done
expect "$pay" P15 FAIL
expect_overall "$pay" PASS

echo "== one precondition taken away at a time"
take_away() { # sql to break, sql to restore, script, check id
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null
  local out
  out=$(run_script "$3")
  expect "$out" "$4" FAIL
  expect_overall "$out" FAIL
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -c "$2" >/dev/null
}
take_away "ALTER TABLE public.trade_invoices DISABLE TRIGGER trade_invoices_job_amount_guard" \
  "ALTER TABLE public.trade_invoices ENABLE TRIGGER trade_invoices_job_amount_guard" \
  cap-switch-preconditions.sql C08
take_away "GRANT EXECUTE ON FUNCTION public.job_backed_room(uuid) TO authenticated" \
  "REVOKE EXECUTE ON FUNCTION public.job_backed_room(uuid) FROM authenticated" \
  cap-switch-preconditions.sql C09
take_away "UPDATE public.trade_pay_settings SET pay_run_approver_user_ids = pay_run_approver_user_ids || '00000000-0000-0000-0000-0000000000ff'::uuid WHERE id = 1" \
  "UPDATE public.trade_pay_settings SET pay_run_approver_user_ids = ARRAY['00000000-0000-0000-0000-0000000000a1']::uuid[] WHERE id = 1" \
  pay-run-switch-preconditions.sql P05
take_away "DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118115852'" \
  "INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('20261118115852')" \
  pay-run-switch-preconditions.sql P09
# A missing settings table or ledger is a FAIL row, never a psql error.
take_away "ALTER TABLE public.trade_pay_settings RENAME TO trade_pay_settings_away" \
  "ALTER TABLE public.trade_pay_settings_away RENAME TO trade_pay_settings" \
  cap-switch-preconditions.sql C03
take_away "ALTER TABLE public.trade_pay_settings RENAME TO trade_pay_settings_away" \
  "ALTER TABLE public.trade_pay_settings_away RENAME TO trade_pay_settings" \
  pay-run-switch-preconditions.sql P05
take_away "ALTER TABLE supabase_migrations.schema_migrations RENAME TO schema_migrations_away" \
  "ALTER TABLE supabase_migrations.schema_migrations_away RENAME TO schema_migrations" \
  cap-switch-preconditions.sql C14
# No start date: nothing would be capped, so C15 fails; a missing table too.
take_away "UPDATE public.work_order_cap_settings SET cap_start_on = NULL WHERE id = 1" \
  "UPDATE public.work_order_cap_settings SET cap_start_on = '2026-11-16' WHERE id = 1" \
  cap-switch-preconditions.sql C15
take_away "ALTER TABLE public.work_order_cap_settings RENAME TO work_order_cap_settings_away" \
  "ALTER TABLE public.work_order_cap_settings_away RENAME TO work_order_cap_settings" \
  cap-switch-preconditions.sql C15
# Without #1643's door the raise is positional only and trade_invoice_lines has
# no org_id: C10 and C11 fail together.
take_away "ALTER FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid) RENAME TO zz_door_away" \
  "ALTER FUNCTION public.zz_door_away(text,text,text,uuid[],jsonb,jsonb,text,uuid) RENAME TO reconcile_item_raise_named" \
  cap-switch-preconditions.sql C11
# F03 is read after a send and is not counted: it fails alone, overall stays PASS.
psql "$URL" -X -q -v ON_ERROR_STOP=1 -c "UPDATE public.reconcile_items SET subject_id = 'zz-away' WHERE subject_id = '00000000-0000-0000-0000-0000000000e1'" >/dev/null
out=$(run_script cap-switch-preconditions.sql)
expect "$out" F03 FAIL
expect_overall "$out" PASS
psql "$URL" -X -q -v ON_ERROR_STOP=1 -c "UPDATE public.reconcile_items SET subject_id = '00000000-0000-0000-0000-0000000000e1' WHERE subject_id = 'zz-away'" >/dev/null

if [ "$failures" -ne 0 ]; then
  echo "switch preconditions proof: $failures failure(s)" >&2
  exit 1
fi
echo "switch preconditions proof passed"
