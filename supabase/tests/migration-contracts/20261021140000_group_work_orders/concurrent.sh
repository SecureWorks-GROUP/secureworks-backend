#!/usr/bin/env bash
# Two invoice freezes and a late joiner, in separate sessions.
#
# Session A freezes the 2h/2h split and holds the group row lock (the
# freeze's SELECT ... FOR UPDATE lasts until A commits). The parent waits
# until A's client has the 321.43 snapshot and A is still inside that
# transaction. Session B then changes A's hours and freezes: it blocks on
# the same row, then must return A's snapshot, not a split of the new
# hours. Session C inserts a participant: it blocks on the joiner trigger's
# lock, then is refused group_split_frozen. The stored shares stay
# 321.43 and 160.72 and sum to the pot.
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgresql://*@localhost:*/*) ;;
  *) echo 'local database required' >&2; exit 2 ;;
esac

ORG=00000000-0000-0000-0000-000000000001
SHAUN=9913309f-35ae-4a71-8e1f-f704ecc526ea
CREW_A=c2140000-0000-4000-8000-00000000000a
CREW_B=c2140000-0000-4000-8000-00000000000b
CREW_C=c2140000-0000-4000-8000-00000000000c
JOB=c2140000-0000-4000-8000-000000000111
GROUP=c2140000-0000-4000-8000-000000000211

tmp=$(mktemp -d)
a_pid=
b_pid=
c_pid=
cleanup() {
  if [ -n "${a_pid}" ]; then kill "$a_pid" 2>/dev/null || true; fi
  if [ -n "${b_pid}" ]; then kill "$b_pid" 2>/dev/null || true; fi
  if [ -n "${c_pid}" ]; then kill "$c_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('${SHAUN}', '${ORG}', 'Shaun', 'ops_manager'),
  ('${CREW_A}', '${ORG}', 'Race A', 'crew'),
  ('${CREW_B}', '${ORG}', 'Race B', 'crew'),
  ('${CREW_C}', '${ORG}', 'Race C', 'crew')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.jobs (id, org_id, type, status, job_number)
VALUES ('${JOB}', '${ORG}', 'fencing', 'quoted', 'GWO-RACE');
INSERT INTO public.work_orders (
  org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
) VALUES (
  '${ORG}', '${JOB}', 'GWO-RACE-1', 'job', 'draft', 482.15, '[]', 'group split race'
);
UPDATE public.work_orders
SET status = 'approved', approved_by = '${SHAUN}'
WHERE wo_number = 'GWO-RACE-1';
INSERT INTO public.trade_rates (id, org_id, user_id, hourly_rate, effective_from) VALUES
  ('c2140000-0000-4000-8000-0000000000a1', '${ORG}', '${CREW_A}', 40, '2026-01-01'),
  ('c2140000-0000-4000-8000-0000000000b1', '${ORG}', '${CREW_B}', 20, '2026-01-01');
INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
SELECT '${GROUP}', '${ORG}', '${JOB}', wo.id, 'token-race'
FROM public.work_orders wo
WHERE wo.wo_number = 'GWO-RACE-1';
INSERT INTO public.group_work_order_participants (group_id, user_id) VALUES
  ('${GROUP}', '${CREW_A}'),
  ('${GROUP}', '${CREW_B}');
INSERT INTO public.group_work_order_time_entries
  (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
VALUES
  ('${GROUP}', '${CREW_A}', '2026-10-21', '08:00', '10:00', 0, 2.00),
  ('${GROUP}', '${CREW_B}', '2026-10-21', '08:00', '10:00', 0, 2.00);
SQL

# Line-buffered so the freeze result is visible while the row lock is held.
stdbuf -oL -eL psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  >"$tmp/a.out" 2>"$tmp/a.err" <<SQL &
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.freeze_group_work_order_split('${GROUP}'::uuid);
\echo freeze-visible
SELECT pg_sleep(2);
COMMIT;
SQL
a_pid=$!

seen=0
for _ in $(seq 1 100); do
  if grep -q 'freeze-visible' "$tmp/a.out" && grep -q '321.43' "$tmp/a.out"; then
    seen=1
    break
  fi
  if ! kill -0 "$a_pid" 2>/dev/null; then
    echo 'session A exited before its freeze was visible' >&2
    cat "$tmp/a.out" "$tmp/a.err" >&2
    exit 1
  fi
  sleep 0.05
done
if [ "$seen" -ne 1 ] || ! kill -0 "$a_pid" 2>/dev/null; then
  echo 'session A did not hold the freeze lock' >&2
  cat "$tmp/a.out" "$tmp/a.err" >&2
  exit 1
fi

stdbuf -oL -eL psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  >"$tmp/b.out" 2>"$tmp/b.err" <<SQL &
UPDATE public.group_work_order_time_entries
SET hours = 7.50
WHERE group_id = '${GROUP}' AND user_id = '${CREW_A}';
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.freeze_group_work_order_split('${GROUP}'::uuid);
COMMIT;
SQL
b_pid=$!

stdbuf -oL -eL psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  >"$tmp/c.out" 2>"$tmp/c.err" <<SQL &
BEGIN;
SET LOCAL ROLE service_role;
INSERT INTO public.group_work_order_participants (group_id, user_id)
VALUES ('${GROUP}', '${CREW_C}');
COMMIT;
SQL
c_pid=$!

if ! wait "$a_pid"; then
  echo 'session A failed' >&2
  cat "$tmp/a.out" "$tmp/a.err" >&2
  exit 1
fi
a_pid=
if ! wait "$b_pid"; then
  echo 'session B failed' >&2
  cat "$tmp/b.out" "$tmp/b.err" >&2
  exit 1
fi
b_pid=
set +e
wait "$c_pid"
c_status=$?
set -e
c_pid=
if [ "$c_status" -eq 0 ]; then
  echo 'session C stored a late joiner' >&2
  cat "$tmp/c.out" "$tmp/c.err" >&2
  exit 1
fi
if ! grep -q 'group_split_frozen' "$tmp/c.err"; then
  echo 'session C failed for a different reason' >&2
  cat "$tmp/c.out" "$tmp/c.err" >&2
  exit 1
fi

if ! grep -q '321.43' "$tmp/b.out" || ! grep -q '160.72' "$tmp/b.out"; then
  echo 'session B did not return the frozen snapshot' >&2
  cat "$tmp/b.out" "$tmp/b.err" >&2
  exit 1
fi
if grep -q '425.43' "$tmp/b.out" || grep -q '56.72' "$tmp/b.out"; then
  echo 'session B recomputed from the hours changed under the lock' >&2
  cat "$tmp/b.out" "$tmp/b.err" >&2
  exit 1
fi

psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  v_a numeric;
  v_b numeric;
  v_sum numeric;
  v_hours numeric;
BEGIN
  SELECT share_ex INTO v_a FROM public.group_work_order_shares
  WHERE group_id = '${GROUP}' AND user_id = '${CREW_A}';
  SELECT share_ex INTO v_b FROM public.group_work_order_shares
  WHERE group_id = '${GROUP}' AND user_id = '${CREW_B}';
  SELECT round(sum(share_ex), 2) INTO v_sum FROM public.group_work_order_shares
  WHERE group_id = '${GROUP}';
  SELECT hours INTO v_hours FROM public.group_work_order_time_entries
  WHERE group_id = '${GROUP}' AND user_id = '${CREW_A}';
  IF v_a IS DISTINCT FROM 321.43 OR v_b IS DISTINCT FROM 160.72
     OR v_sum IS DISTINCT FROM 482.15
  THEN
    RAISE EXCEPTION 'group-wo race: shares are % and % (sum %)', v_a, v_b, v_sum;
  END IF;
  IF v_hours IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'group-wo race: the hour edit did not land (% )', v_hours;
  END IF;
  IF (SELECT count(*) FROM public.group_work_order_participants WHERE group_id = '${GROUP}') <> 2
     OR EXISTS (
       SELECT 1 FROM public.group_work_order_participants
       WHERE group_id = '${GROUP}' AND user_id = '${CREW_C}'
     )
  THEN
    RAISE EXCEPTION 'group-wo race: the late joiner was stored';
  END IF;
  IF (SELECT count(*) FROM public.group_work_order_shares WHERE group_id = '${GROUP}') <> 2 THEN
    RAISE EXCEPTION 'group-wo race: the snapshot row count moved';
  END IF;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id = '${GROUP}') IS NULL THEN
    RAISE EXCEPTION 'group-wo race: the split was not frozen';
  END IF;
END \$\$;
SQL
