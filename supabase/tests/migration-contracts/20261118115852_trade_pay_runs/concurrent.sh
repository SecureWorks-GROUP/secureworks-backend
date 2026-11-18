#!/usr/bin/env bash
# P1-10.1 rollback against a concurrent approval, both orderings, in real
# sessions. Every id and word is made up (ZZTEST). Leaves the database as it
# found it: the one run ordering 1 commits, the made-up approver and the
# approver list are restored by the trap; ordering 2's rollback is rolled back.
#
# 1. Approval first: an approval holds its locks uncommitted when the rollback
#    starts. The rollback must wait for it, then see its run and refuse
#    (before the fix it checked emptiness first, passed, and erased the run).
# 2. Rollback first: the rollback holds its locks uncommitted. An approval
#    started now cannot write a run; it waits and times out.
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
 postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
 *) echo 'local disposable database only' >&2; exit 2 ;;
esac
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
down="$here/../../../rollbacks/20261118115852_trade_pay_runs_down.sql"
if [ "${GITHUB_ACTIONS:-}" = true ]; then
 proof_root="${RUNNER_TEMP:?GitHub runner scratch required}/cl-1578-81"
else
 proof_root=/Volumes/SSD/agent-scratch/cl-1578-81
fi
mkdir -p "$proof_root"
proof_dir=$(mktemp -d "$proof_root/concurrent.XXXXXX")

org=00000000-0000-4000-8000-0000000000c1
actor=0a1c0000-0000-4000-8000-000000000001
db() { psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
old_approvers=$(db -At -c "SELECT pay_run_approver_user_ids::text FROM public.trade_pay_settings WHERE id = 1")
bg_pid=
cleanup() {
 if [ -n "$bg_pid" ]; then wait "$bg_pid" || true; fi
 db -q <<SQL
DELETE FROM public.trade_pay_run_invoices WHERE run_id IN (SELECT id FROM public.trade_pay_runs WHERE org_id = '$org');
DELETE FROM public.trade_pay_runs WHERE org_id = '$org';
UPDATE public.trade_pay_settings SET pay_run_approver_user_ids = '$old_approvers'::uuid[] WHERE id = 1;
DELETE FROM public.users WHERE id = '$actor';
SQL
 # cl-1622-fix: whatever happened above, leave the successor's body live if it was.
 if [ "${successor_live:-f}" = t ] && [ "$(db -At -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.approve_trade_pay_run(uuid,date,uuid,jsonb)')")" != dc17fd7b51c2916054ede4801eb8ead1 ]; then
  db -q -1 -f "$successor"
  if [ "${check_successors_live:-f}" = t ]; then db -q -1 -f "$successor_check_up"; fi
 fi
}
trap cleanup EXIT
db -q <<SQL
INSERT INTO public.users (id, org_id, name, role) VALUES ('$actor', '$org', 'ZZTEST approver', 'admin');
UPDATE public.trade_pay_settings SET pay_run_approver_user_ids = ARRAY['$actor'::uuid] WHERE id = 1;
SQL
# cl-1622-fix: 20261118163000 replaces approve_trade_pay_run (it keeps the
# status and refuses an empty week). These proofs are about P1-10.1's own
# body and its rollback, so each session that approves puts P1-10.1's body
# back first, and this migration is re-applied once ordering 1 is done.
successor="$here/../../../migrations/20261118163000_trade_pay_run_holds_status.sql"
successor_down="$here/../../../rollbacks/20261118163000_trade_pay_run_holds_status_down.sql"
# Later check bodies on 20261118163000's are rolled back first (newest first).
successor_check_down="$here/../20261118163000_trade_pay_run_holds_status/roll_back_check_successors.sql"
successor_check_up="$here/../20261118163000_trade_pay_run_holds_status/reapply_check_successors.sql"
check_successors_live=$(db -At -c "SELECT coalesce((SELECT md5(prosrc) NOT IN ('7bf3b7dbccc9c5ef8656b6c43e3e9a0b', 'c36b18bc0c4c4bc4b1ffed9021717664') FROM pg_proc WHERE oid = to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)')), false)")
successor_live=$(db -At -c "SELECT coalesce((SELECT md5(prosrc) = 'dc17fd7b51c2916054ede4801eb8ead1' FROM pg_proc WHERE oid = to_regprocedure('public.approve_trade_pay_run(uuid,date,uuid,jsonb)')), false)")
successor_first() {
 if [ "$successor_live" = t ]; then printf "\\i '%s'\n\\i '%s'\n" "$successor_check_down" "$successor_down"; fi
}
approve_sql() {
 printf "SELECT public.approve_trade_pay_run('%s', '%s', '%s', '{\"check_rule\":\"v2\",\"invoices\":[]}');" "$org" "$1" "$actor"
}
wait_for() {
 for _ in $(seq 1 200); do [ ! -f "$1" ] || return 0; sleep 0.05; done
 echo "session did not become ready: $1" >&2; exit 1
}

# ── 1. approval first ──────────────────────────────────────────────────────
db -q > "$proof_dir/approve1.log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout = '10s';
$(successor_first)
$(approve_sql 2026-11-16)
\! touch '$proof_dir/approve1.ready'
SELECT pg_sleep(1.5);
COMMIT;
SQL
bg_pid=$!
wait_for "$proof_dir/approve1.ready"
set +e
down_out=$(psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -1 -f "$down" 2>&1)
down_status=$?
set -e
wait "$bg_pid"
bg_pid=
if [ "$down_status" -eq 0 ] || ! grep -Fq 'pay runs are recorded; they cannot be dropped' <<< "$down_out"; then
 printf '%s\n' "$down_out" >&2
 echo 'ZZTEST ordering 1: the rollback did not wait for the approval and refuse its run' >&2
 exit 1
fi
db -q <<SQL
DO \$c\$ BEGIN
 IF to_regclass('public.trade_pay_runs') IS NULL
    OR (SELECT count(*) FROM public.trade_pay_runs WHERE org_id = '$org' AND week_start = '2026-11-16') <> 1
    OR to_regprocedure('public.approve_trade_pay_run(uuid,date,uuid,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'ZZTEST ordering 1: the committed run or its record did not survive the rollback';
 END IF;
END \$c\$;
DELETE FROM public.trade_pay_runs WHERE org_id = '$org';
SQL
if [ "$successor_live" = t ]; then db -q -1 -f "$successor"; fi # the trap does this too on an early exit
if [ "$successor_live" = t ] && [ "$check_successors_live" = t ]; then db -q -1 -f "$successor_check_up"; fi
echo 'PASS: ordering 1, the rollback waits for a running approval, sees its run and refuses'

# ── 2. rollback first ──────────────────────────────────────────────────────
db -q > "$proof_dir/down2.log" 2>&1 <<SQL &
BEGIN;
-- cl-1622-fix: P1-10.1's own body first (rolled back with the rest).
$(successor_first)
\i '$down'
\! touch '$proof_dir/down2.ready'
SELECT pg_sleep(1.5);
ROLLBACK;
SQL
bg_pid=$!
wait_for "$proof_dir/down2.ready"
set +e
approve_out=$(psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SET lock_timeout = '300ms'" -c "$(approve_sql 2026-11-23)" 2>&1)
approve_status=$?
set -e
wait "$bg_pid"
bg_pid=
if [ "$approve_status" -eq 0 ] || ! grep -Fq 'lock timeout' <<< "$approve_out"; then
 printf '%s\n' "$approve_out" >&2
 echo 'ZZTEST ordering 2: an approval wrote while the rollback held its locks' >&2
 exit 1
fi
db -q <<SQL
DO \$c\$ BEGIN
 IF to_regclass('public.trade_pay_runs') IS NULL
    OR EXISTS (SELECT 1 FROM public.trade_pay_runs WHERE org_id = '$org') THEN
  RAISE EXCEPTION 'ZZTEST ordering 2: a run was written behind the rollback, or the rollback was not undone';
 END IF;
END \$c\$;
SQL
echo 'PASS: ordering 2, an approval cannot write a run while the rollback holds its locks'
