#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?disposable local contract database required}"
case "$CONTRACT_DATABASE_URL" in
 postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
 *) echo 'local disposable database only' >&2; exit 2 ;;
esac
case_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
if [ "${GITHUB_ACTIONS:-}" = true ]; then
 proof_root="${RUNNER_TEMP:?runner scratch required}/cx-p1-05-12"
else
 proof_root=/Volumes/SSD/agent-scratch/cx-p1-05-12
fi
mkdir -p "$proof_root"
proof_dir=$(mktemp -d "$proof_root/concurrent.XXXXXX")
job=f1050900-0000-4000-8000-000000000001
first=f1050900-0000-4000-8000-000000000004
second=f1050900-0000-4000-8000-000000000005
old_flag=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT enabled FROM public.feature_flags WHERE flag_name='trade_line_hold_v1'")
old_trigger=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT tgenabled FROM pg_trigger WHERE tgname='trade_invoice_lines_job_amount_guard' AND tgrelid='public.trade_invoice_lines'::regclass")
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
 case "$old_trigger" in
  '') psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'SELECT public.remove_trade_line_job_amount_guard()' >/dev/null ;;
  O) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoice_lines ENABLE TRIGGER trade_invoice_lines_job_amount_guard' ;;
  D) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoice_lines DISABLE TRIGGER trade_invoice_lines_job_amount_guard' ;;
  R) psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'ALTER TABLE public.trade_invoice_lines ENABLE REPLICA TRIGGER trade_invoice_lines_job_amount_guard' ;;
 esac
}
trap cleanup EXIT
psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SET LOCAL session_replication_role=replica;
\i '$case_dir/fixture.sql'
UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_line_hold_v1';
SELECT public.install_trade_line_job_amount_guard();
ALTER TABLE public.trade_invoice_lines ENABLE ALWAYS TRIGGER trade_invoice_lines_job_amount_guard;
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
SELECT pg_sleep(0.2);
COMMIT;
SQL
 first_pid=$!
 for attempt in $(seq 1 200); do
  [ ! -f "$proof_dir/ready-$run" ] || break
  sleep 0.01
 done
 [ -f "$proof_dir/ready-$run" ] || { cat "$proof_dir/first-$run.log"; exit 1; }
 set +e
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 >"$proof_dir/second-$run.log" 2>&1 <<SQL
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
echo 'ZZTEST P1-05.9 concurrent: 20 of 20, one commit and one job_amount_guard; job never over'
