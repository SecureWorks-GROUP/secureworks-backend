#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
 postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
 *) echo 'local disposable database only' >&2; exit 2 ;;
esac
proof_root=/Volumes/SSD/agent-scratch/cx-p0-09-45
mkdir -p "$proof_root"
proof_dir=$(mktemp -d "$proof_root/concurrent.XXXXXX")
proof_job=ffffffff-ffff-4fff-8fff-ffffffffff45
old_flag=$(psql "$CONTRACT_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT enabled FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1'")
locker_pid=
cleanup() {
 if [ -n "$locker_pid" ]; then wait "$locker_pid" || true; fi
 psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
DROP TABLE IF EXISTS public.job_profit_concurrent_probe;
DELETE FROM public.job_profit_change_events WHERE job_id='$proof_job';
DELETE FROM public.job_profit_dirty WHERE job_id='$proof_job';
UPDATE public.feature_flags SET enabled='$old_flag' WHERE flag_name='job_profit_refresh_v1';
SQL
}
trap cleanup EXIT
psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_profit_refresh_v1';
CREATE TABLE public.job_profit_concurrent_probe(id int,job_id uuid);
CREATE TRIGGER source_write AFTER INSERT ON public.job_profit_concurrent_probe
 FOR EACH ROW EXECUTE FUNCTION public.job_profit_purchase_orders_trg();
INSERT INTO public.job_profit_change_events(job_id,reason) VALUES('$proof_job','fixture_lock');
SELECT public.job_profit_mark('$proof_job','fixture_lock');
SQL
psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 > "$proof_dir/locker.log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='10s';
SELECT id FROM public.job_profit_change_events WHERE job_id='$proof_job' FOR UPDATE;
SELECT job_id FROM public.job_profit_dirty WHERE job_id='$proof_job' FOR UPDATE;
\! touch '$proof_dir/locked'
SELECT pg_sleep(3);
ROLLBACK;
SQL
locker_pid=$!
for attempt in $(seq 1 100); do
 [ ! -f "$proof_dir/locked" ] || break
 sleep 0.05
done
[ -f "$proof_dir/locked" ] || { echo 'locker did not become ready' >&2; exit 1; }
psql "$CONTRACT_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
SET lock_timeout='100ms';
SET statement_timeout='500ms';
INSERT INTO public.job_profit_concurrent_probe VALUES(1,'$proof_job');
DO \$check\$ BEGIN
 IF (SELECT count(*) FROM public.job_profit_change_events WHERE job_id='$proof_job')<>2 THEN
  RAISE EXCEPTION 'source write waited for or lost mark behind worker locks';
 END IF;
END \$check\$;
SQL
wait "$locker_pid"
locker_pid=
echo 'PASS: source append completes under 500ms while both prior queue and dirty rows are locked'
