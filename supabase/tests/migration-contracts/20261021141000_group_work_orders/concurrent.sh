#!/usr/bin/env bash
# A freeze under a row lock, a late joiner, and two submits of one share.
#
# Session A freezes the 2h/2h split and holds the group row lock until it
# commits. Session B's hour edit waits on that lock, then is refused
# group_split_frozen, and B's freeze returns the stored 321.43 / 160.72
# snapshot. Session C is refused group_split_frozen. Hours stay 2.00.
# After that, two sessions insert the same share onto two invoices: one
# stores the line and the other is refused group_share_already_invoiced.
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
d_pid=
e_pid=
cleanup() {
  if [ -n "${a_pid}" ]; then kill "$a_pid" 2>/dev/null || true; fi
  if [ -n "${b_pid}" ]; then kill "$b_pid" 2>/dev/null || true; fi
  if [ -n "${c_pid}" ]; then kill "$c_pid" 2>/dev/null || true; fi
  if [ -n "${d_pid}" ]; then kill "$d_pid" 2>/dev/null || true; fi
  if [ -n "${e_pid}" ]; then kill "$e_pid" 2>/dev/null || true; fi
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
INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status) VALUES
  ('c2140000-0000-4000-8000-0000000000a2', '${JOB}', '${CREW_A}', '2026-10-21', 'scheduled'),
  ('c2140000-0000-4000-8000-0000000000b2', '${JOB}', '${CREW_B}', '2026-10-21', 'scheduled');
INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
VALUES (
  'c2140000-0000-4000-8000-000000000501', '${JOB}', 'signature', 'photo',
  'data:image/png;base64,iVBORw0KGgo='
);
INSERT INTO public.job_client_signoffs (
  job_id, method, signed_name, happy, satisfaction_rating,
  signature_media_id, captured_by_actor
) VALUES (
  '${JOB}', 'share_link', 'Alex Client', true, 5,
  'c2140000-0000-4000-8000-000000000501', 'client link'
);
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
\set ON_ERROR_STOP off
UPDATE public.group_work_order_time_entries
SET hours = 7.50
WHERE group_id = '${GROUP}' AND user_id = '${CREW_A}';
\set ON_ERROR_STOP on
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

if ! grep -q 'group_split_frozen' "$tmp/b.err"; then
  echo 'session B edited hours on a frozen split' >&2
  cat "$tmp/b.out" "$tmp/b.err" >&2
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
  IF v_hours IS DISTINCT FROM 2.00 THEN
    RAISE EXCEPTION 'group-wo race: frozen hours moved (%)', v_hours;
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

INSERT INTO public.trade_invoices (
  id, org_id, user_id, status, subtotal_ex, gst, total_inc,
  gst_on, super_rate, super_amount, gross_earned, net_pay
) VALUES
  ('c2140000-0000-4000-8000-000000000401', '${ORG}', '${CREW_A}', 'draft',
   321.43, 0, 321.43, false, 0.12, 38.57, 321.43, 302.14),
  ('c2140000-0000-4000-8000-000000000402', '${ORG}', '${CREW_A}', 'draft',
   321.43, 0, 321.43, false, 0.12, 38.57, 321.43, 302.14);
SQL

stdbuf -oL -eL psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  >"$tmp/d.out" 2>"$tmp/d.err" <<SQL &
INSERT INTO public.trade_invoice_lines (
  trade_invoice_id, job_id, line_type, line_total_ex
) VALUES (
  'c2140000-0000-4000-8000-000000000401', '${JOB}', 'group share', 321.43
);
SQL
d_pid=$!
stdbuf -oL -eL psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  >"$tmp/e.out" 2>"$tmp/e.err" <<SQL &
INSERT INTO public.trade_invoice_lines (
  trade_invoice_id, job_id, line_type, line_total_ex
) VALUES (
  'c2140000-0000-4000-8000-000000000402', '${JOB}', 'group share', 321.43
);
SQL
e_pid=$!
set +e
wait "$d_pid"
d_status=$?
wait "$e_pid"
e_status=$?
set -e
d_pid=
e_pid=
if [ "$d_status" -eq 0 ] && [ "$e_status" -eq 0 ]; then
  echo 'both share submits stored a line' >&2
  cat "$tmp/d.out" "$tmp/d.err" "$tmp/e.out" "$tmp/e.err" >&2
  exit 1
fi
if [ "$d_status" -ne 0 ] && [ "$e_status" -ne 0 ]; then
  echo 'neither share submit stored a line' >&2
  cat "$tmp/d.out" "$tmp/d.err" "$tmp/e.out" "$tmp/e.err" >&2
  exit 1
fi
if ! grep -q 'group_share_already_invoiced' "$tmp/d.err" "$tmp/e.err"; then
  echo 'the losing share submit failed for a different reason' >&2
  cat "$tmp/d.out" "$tmp/d.err" "$tmp/e.out" "$tmp/e.err" >&2
  exit 1
fi

psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM public.trade_invoice_lines l
  JOIN public.group_work_order_shares s ON s.id = l.group_share_id
  WHERE s.group_id = '${GROUP}' AND s.user_id = '${CREW_A}';
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'group-wo race: % live lines stored one share', n;
  END IF;
END \$\$;
SQL
