#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?disposable contract database required}"
case "$CONTRACT_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgresql://*@localhost:*/*) ;;
  *) exit 2 ;;
esac
case_dir=$(dirname "$0")
proof_dir=$(mktemp -d)
a_pid=
cleanup() {
  if [ -n "$a_pid" ]; then kill "$a_pid" 2>/dev/null || true; fi
  rm -rf "$proof_dir"
}
trap cleanup EXIT
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'SELECT public.install_trade_repayment_save_lock();'
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$case_dir/fixture.sql"
# Leave only the last instalment, then race two different invoice weeks.
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v week=2099-01-05 -v hold=0 -f "$case_dir/save.sql"
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v week=2099-01-12 -v hold=0 -f "$case_dir/save.sql"
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v week=2099-01-19 -v hold=3 -f "$case_dir/save.sql" > "$proof_dir/a.log" 2>&1 &
a_pid=$!
for attempt in $(seq 1 100); do
  if grep -q 'ZZTEST saved' "$proof_dir/a.log"; then break; fi
  sleep 0.02
done
grep -q 'ZZTEST saved' "$proof_dir/a.log"
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v week=2099-01-26 -v hold=0 -f "$case_dir/save.sql"
wait "$a_pid"
a_pid=
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT sum(recurring_deduction_amount) FROM public.trade_invoices WHERE user_id='ee320000-0000-4000-8000-000000000001') IS DISTINCT FROM 250 THEN
    RAISE EXCEPTION 'ZZTEST concurrent saves over-collected'; END IF;
END $$;
SELECT public.remove_trade_repayment_save_lock();
DELETE FROM public.trade_invoices WHERE user_id='ee320000-0000-4000-8000-000000000001';
DELETE FROM public.trade_recurring_deductions WHERE id='ee320000-0000-4000-8000-000000000002';
DELETE FROM public.users WHERE id='ee320000-0000-4000-8000-000000000001';
UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_repayments_v1';
SQL
