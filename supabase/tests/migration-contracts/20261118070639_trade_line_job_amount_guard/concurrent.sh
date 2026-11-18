#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?disposable local contract database required}"
case "$CONTRACT_DATABASE_URL" in
 postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
 *) echo 'local disposable database only' >&2; exit 2 ;;
esac
case_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
if [ "${GITHUB_ACTIONS:-}" = true ]; then
 proof_root="${RUNNER_TEMP:?runner scratch required}/p1-05-9-concurrent"
else
 proof_root=/Volumes/SSD/agent-scratch/cl-1575-hold
fi
mkdir -p "$proof_root"
proof_dir=$(mktemp -d "$proof_root/concurrent.XXXXXX")
job=f1050900-0000-4000-8000-000000000001
first=f1050900-0000-4000-8000-000000000004
second=f1050900-0000-4000-8000-000000000005
old_flag=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT enabled FROM public.feature_flags WHERE flag_name='trade_line_hold_v1'")
old_trigger=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT tgenabled FROM pg_trigger WHERE tgname='trade_invoice_lines_job_amount_guard' AND tgrelid='public.trade_invoice_lines'::regclass")
# 20261118193817 caps only jobs approved on or after work_order_cap_settings.cap_start_on;
# this race needs its job capped, so a start date before the fixture's approval is set and
# the earlier value put back on exit.
old_start=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN to_regclass('public.work_order_cap_settings') IS NULL THEN 'absent' ELSE coalesce((SELECT cap_start_on::text FROM public.work_order_cap_settings WHERE id=1),'null') END")
old_header=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT tgenabled FROM pg_trigger WHERE tgname='trade_invoices_job_amount_guard' AND tgrelid='public.trade_invoices'::regclass")
first_pid=
cleanup() {
 if [ -n "$first_pid" ]; then wait "$first_pid" || true; fi
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id IN('$first','$second');
DELETE FROM public.trade_invoices WHERE id IN('$first','$second');
DELETE FROM public.work_orders WHERE id='f1050900-0000-4000-8000-000000000002';
DELETE FROM public.jobs WHERE id='$job';
UPDATE public.feature_flags SET enabled='$old_flag' WHERE flag_name='trade_line_hold_v1';
COMMIT;
SQL
 case "$old_start" in
  absent) ;;
  null) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "UPDATE public.work_order_cap_settings SET cap_start_on=NULL WHERE id=1" ;;
  *) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "UPDATE public.work_order_cap_settings SET cap_start_on='$old_start' WHERE id=1" ;;
 esac
 case "$old_trigger" in
  '') psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'SELECT public.remove_trade_line_job_amount_guard()' >/dev/null ;;
  O) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoice_lines ENABLE TRIGGER trade_invoice_lines_job_amount_guard' ;;
  D) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoice_lines DISABLE TRIGGER trade_invoice_lines_job_amount_guard' ;;
  R) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoice_lines ENABLE REPLICA TRIGGER trade_invoice_lines_job_amount_guard' ;;
 esac
 case "$old_header" in
  '') psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'DROP TRIGGER IF EXISTS trade_invoices_job_amount_guard ON public.trade_invoices' ;;
  O) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoices ENABLE TRIGGER trade_invoices_job_amount_guard' ;;
  D) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoices DISABLE TRIGGER trade_invoices_job_amount_guard' ;;
  R) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoices ENABLE REPLICA TRIGGER trade_invoices_job_amount_guard' ;;
 esac
}
# Hold the first session open until the second session (named by PGAPPNAME) is seen waiting on
# a lock, so every run proves a real wait rather than relying on a sleep being long enough.
second_app=zztest_p1059_second
wait_for_waiter="DO \$w\$ DECLARE seen boolean:=false; BEGIN
 FOR n IN 1..500 LOOP
  PERFORM pg_stat_clear_snapshot();
  SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
   WHERE a.application_name='$second_app' AND NOT l.granted) INTO seen;
  EXIT WHEN seen;
  PERFORM pg_sleep(0.01);
 END LOOP;
 IF NOT seen THEN RAISE EXCEPTION 'ZZTEST second session never waited on a lock'; END IF;
END \$w\$;"
trap cleanup EXIT
psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SET LOCAL session_replication_role=replica;
\i '$case_dir/fixture.sql'
UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_line_hold_v1';
DO \$s\$ BEGIN
 IF to_regclass('public.work_order_cap_settings') IS NOT NULL THEN
  UPDATE public.work_order_cap_settings SET cap_start_on='2000-01-01' WHERE id=1;
 END IF;
END \$s\$;
SELECT public.install_trade_line_job_amount_guard();
ALTER TABLE public.trade_invoice_lines ENABLE ALWAYS TRIGGER trade_invoice_lines_job_amount_guard;
ALTER TABLE public.trade_invoices ENABLE ALWAYS TRIGGER trade_invoices_job_amount_guard;
COMMIT;
SQL
for run in $(seq 1 20); do
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
SET session_replication_role=replica;
DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id IN('$first','$second');
SQL
 # Session two starts its INSERT while session one holds the job lock, before commit.
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 >"$proof_dir/first-$run.log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL session_replication_role=replica;
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES('$first','$job','labour',100);
\! touch '$proof_dir/ready-$run'
$wait_for_waiter
COMMIT;
SQL
 first_pid=$!
 for attempt in $(seq 1 200); do
  [ ! -f "$proof_dir/ready-$run" ] || break
  sleep 0.01
 done
 [ -f "$proof_dir/ready-$run" ] || { cat "$proof_dir/first-$run.log"; exit 1; }
 set +e
 PGAPPNAME=$second_app psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 >"$proof_dir/second-$run.log" 2>&1 <<SQL
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL session_replication_role=replica;
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES('$second','$job','labour',100);
COMMIT;
SQL
 second_status=$?
 wait "$first_pid"
 first_status=$?
 first_pid=
 set -e
 [ "$first_status" -eq 0 ] && [ "$second_status" -ne 0 ]   && grep -q 'job_amount_guard' "$proof_dir/second-$run.log"   || { cat "$proof_dir/first-$run.log" "$proof_dir/second-$run.log"; exit 1; }
 actual=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*)||':'||sum(line_total_ex)||':'||public.job_backed_room('$job') FROM public.trade_invoice_lines WHERE job_id='$job'")
 [ "$actual" = '1:100.00:20.00' ] || { echo "ZZTEST unexpected committed sum $actual"; exit 1; }
 # Alternate the two invoice identities on the next race.
 swap=$first; first=$second; second=$swap
done
# Header race: both invoices are drafts holding 100 each against 120. Both sessions move their
# header into a counted status; the second waits on the job lock, then reads 20 and is refused.
for run in $(seq 1 20); do
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
SET session_replication_role=replica;
DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id IN('$first','$second');
UPDATE public.trade_invoices SET status='draft' WHERE id IN('$first','$second');
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
VALUES('$first','$job','labour',100),('$second','$job','labour',100);
SQL
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 >"$proof_dir/header-first-$run.log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL session_replication_role=replica;
UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id='$first';
\! touch '$proof_dir/header-ready-$run'
$wait_for_waiter
COMMIT;
SQL
 first_pid=$!
 for attempt in $(seq 1 200); do
  [ ! -f "$proof_dir/header-ready-$run" ] || break
  sleep 0.01
 done
 [ -f "$proof_dir/header-ready-$run" ] || { cat "$proof_dir/header-first-$run.log"; exit 1; }
 set +e
 PGAPPNAME=$second_app psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 >"$proof_dir/header-second-$run.log" 2>&1 <<SQL
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL session_replication_role=replica;
UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id='$second';
COMMIT;
SQL
 second_status=$?
 wait "$first_pid"
 first_status=$?
 first_pid=
 set -e
 [ "$first_status" -eq 0 ] && [ "$second_status" -ne 0 ] && grep -q 'job_amount_guard' "$proof_dir/header-second-$run.log" \
  || { cat "$proof_dir/header-first-$run.log" "$proof_dir/header-second-$run.log"; exit 1; }
 actual=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT (SELECT status FROM public.trade_invoices WHERE id='$second')||':'||public.job_backed_room('$job')")
 [ "$actual" = 'draft:20.00' ] || { echo "ZZTEST unexpected header race result $actual"; exit 1; }
 swap=$first; first=$second; second=$swap
done
# Line into a draft while its header turns counted: the first invoice is counted and holds
# 100 against 120; the second is an empty draft. Session one moves the second header into a
# counted status and holds it; session two adds a 100 line to that same invoice. The line
# guard's FOR SHARE waits for the header, reads it counted, and refuses the line.
for run in $(seq 1 20); do
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
SET session_replication_role=replica;
DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id IN('$first','$second');
UPDATE public.trade_invoices SET status='draft' WHERE id='$second';
UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id='$first';
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
VALUES('$first','$job','labour',100);
SQL
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 >"$proof_dir/draft-first-$run.log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL session_replication_role=replica;
UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id='$second';
\! touch '$proof_dir/draft-ready-$run'
$wait_for_waiter
COMMIT;
SQL
 first_pid=$!
 for attempt in $(seq 1 200); do
  [ ! -f "$proof_dir/draft-ready-$run" ] || break
  sleep 0.01
 done
 [ -f "$proof_dir/draft-ready-$run" ] || { cat "$proof_dir/draft-first-$run.log"; exit 1; }
 set +e
 PGAPPNAME=$second_app psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 >"$proof_dir/draft-second-$run.log" 2>&1 <<SQL
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL session_replication_role=replica;
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES('$second','$job','labour',100);
COMMIT;
SQL
 second_status=$?
 wait "$first_pid"
 first_status=$?
 first_pid=
 set -e
 [ "$first_status" -eq 0 ] && [ "$second_status" -ne 0 ] && grep -q 'job_amount_guard' "$proof_dir/draft-second-$run.log" \
  || { cat "$proof_dir/draft-first-$run.log" "$proof_dir/draft-second-$run.log"; exit 1; }
 actual=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*)||':'||public.job_backed_room('$job') FROM public.trade_invoice_lines WHERE job_id='$job'")
 [ "$actual" = '1:20.00' ] || { echo "ZZTEST unexpected draft race result $actual"; exit 1; }
 swap=$first; first=$second; second=$swap
done
echo 'ZZTEST P1-05.9 concurrent: lines, headers and line-into-turning-draft each 20 of 20, one commit and one job_amount_guard; job never over'
