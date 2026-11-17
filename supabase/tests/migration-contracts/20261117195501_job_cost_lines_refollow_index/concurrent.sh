#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?}"
if [ -z "${FU11_SCRATCH_DIR:-}" ]; then
  : "${RUNNER_TEMP:?set FU11_SCRATCH_DIR for a local task-owned scratch directory}"
  FU11_SCRATCH_DIR="$RUNNER_TEMP/fu11-concurrent-$$"
fi
mkdir -p "$FU11_SCRATCH_DIR"
actor_input="$FU11_SCRATCH_DIR/actor-input"
mkfifo "$actor_input"
cleanup() {
  exec 3>&- || true
  [ -z "${actor_pid:-}" ] || wait "$actor_pid" || true
  [ -z "${worker_pid:-}" ] || wait "$worker_pid" || true
  psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DELETE FROM public.job_cost_lines WHERE document_id='ZZTEST-FU11-concurrent';" >/dev/null
  rm -f "$actor_input"
}
trap cleanup EXIT
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public.job_cost_lines
 (id,org_id,document_kind,document_id,line_key,kind,lane,amount_ex,state,source_hash,
 follows_document_kind,follows_document_id)
VALUES ('93000000-0000-4000-8000-000000000001','93000000-0000-4000-8001-000000000001',
 'xero_credit_note','ZZTEST-FU11-concurrent','1','supplier_credit','materials',-1,
 'needs_person','ZZTEST-FU11','xero_bill','ZZTEST-FU11-before-lock');
SQL
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 < "$actor_input" > "$FU11_SCRATCH_DIR/actor.log" 2>&1 &
actor_pid=$!
exec 3>"$actor_input"
printf '%s\n' 'BEGIN;' "UPDATE public.job_cost_lines SET follows_document_id='ZZTEST-FU11-after-lock' WHERE document_id='ZZTEST-FU11-concurrent';" '\echo ROW_LOCKED' >&3
for attempt in $(seq 1 100); do
  if grep -q ROW_LOCKED "$FU11_SCRATCH_DIR/actor.log"; then break; fi
  sleep 0.1
done
grep -q ROW_LOCKED "$FU11_SCRATCH_DIR/actor.log"
PGAPPNAME=fu11_refollow_waiter psql "$CONTRACT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c "SET statement_timeout='15s'; SELECT public.job_cost_lines_refollow('xero_bill','ZZTEST-FU11-before-lock');" \
  > "$FU11_SCRATCH_DIR/worker.log" 2>&1 &
worker_pid=$!
waiting=no
for attempt in $(seq 1 100); do
  if [ "$(psql "$CONTRACT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fu11_refollow_waiter' AND wait_event_type='Lock');")" = t ]; then
    waiting=yes; break
  fi
  sleep 0.1
done
printf '%s\n' 'COMMIT;' '\q' >&3
exec 3>&-
wait "$actor_pid"
actor_pid=
wait "$worker_pid"
worker_pid=
[ "$waiting" = yes ] || { echo 'FU11: refollow never waited on the changed row'; exit 1; }
grep -qx '0' "$FU11_SCRATCH_DIR/worker.log" || { cat "$FU11_SCRATCH_DIR/worker.log"; exit 1; }
[ "$(psql "$CONTRACT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "SELECT needs_reason IS NULL AND follows_document_id='ZZTEST-FU11-after-lock' FROM public.job_cost_lines WHERE document_id='ZZTEST-FU11-concurrent';")" = t ]
echo 'FU11 concurrent changed-coordinate recheck passed'
