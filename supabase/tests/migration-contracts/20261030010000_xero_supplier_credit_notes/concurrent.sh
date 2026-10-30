#!/usr/bin/env bash
# Two copies of one credit note at once (both xero-sync entry points call the
# same writer). Order is forced, never timed: session A copies and holds its
# transaction open until session B is seen waiting on a lock (pg_locks), then
# commits; B then finishes.
#
#   race1  first copy:   A newer, B older   -> A's note and list survive; B answers stale
#   race2  stored row:   A newer, B older   -> A's note and list survive; B answers stale
#   race3  replay:       A and B the same record -> written twice, one list, no doubles
#   race4  first copy:   A older, B newer   -> B's note and list win (newer wins)
#   race5  stored row:   A with a list, B newer with no list -> A's list is kept,
#                        the note reads allocations not returned
#
# Every row this script commits is deleted at the end, the org row too when
# this script made it.
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgresql://*@localhost:*/*) ;;
  *) echo 'local database required' >&2; exit 2 ;;
esac

ORG=00000000-0000-0000-0000-000000000001
tmp=$(mktemp -d)
a_pid=
b_pid=
cleanup() {
  if [ -n "${a_pid}" ]; then kill "$a_pid" 2>/dev/null || true; fi
  if [ -n "${b_pid}" ]; then kill "$b_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

made_org=$(psql "$CONTRACT_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.organisations (id, name) VALUES ('${ORG}', 'Synthetic org') ON CONFLICT (id) DO NOTHING RETURNING 'made'")

# note(id, updated, mark) and the allocation list as SQL expressions.
note() {
  echo "jsonb_build_object('xero_credit_note_id', '$1', 'credit_note_type', 'ACCPAYCREDIT', 'status', 'AUTHORISED',
    'total', 110, 'remaining_credit', 0, 'xero_updated_at', '$2',
    'raw_json', jsonb_build_object('CreditNoteID', '$1', 'Type', 'ACCPAYCREDIT', 'Mark', '$3'))"
}
alloc() { # bill amount | none
  if [ "$1" = none ]; then echo "NULL::jsonb"; else
    echo "jsonb_build_array(jsonb_build_object('xero_invoice_id', '$1', 'amount', $2, 'raw_json', '{}'::jsonb))"
  fi
}

copy_now() { # id updated mark bill amount
  psql "$CONTRACT_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 -c \
    "SET ROLE service_role; SELECT public.xero_supplier_credit_note_copy('${ORG}', $(note "$1" "$2" "$3"), $(alloc "$4" "$5"));" >/dev/null
}

# race NAME ID  A_UPDATED A_MARK A_BILL A_AMOUNT  B_UPDATED B_MARK B_BILL B_AMOUNT
race() {
  local name=$1 id=$2
  PGAPPNAME="cn-race-a" stdbuf -oL -eL psql "$CONTRACT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
    >"$tmp/$name.a.out" 2>"$tmp/$name.a.err" <<SQL &
BEGIN;
SET LOCAL ROLE service_role;
SELECT 'A:' || public.xero_supplier_credit_note_copy('${ORG}', $(note "$id" "$3" "$4"), $(alloc "$5" "$6"));
RESET ROLE;
\echo a-holding
DO \$\$
BEGIN
  FOR i IN 1..800 LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
                       WHERE NOT l.granted AND s.application_name = 'cn-race-b');
    PERFORM pg_sleep(0.025);
  END LOOP;
  PERFORM pg_stat_clear_snapshot();
  IF NOT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
                  WHERE NOT l.granted AND s.application_name = 'cn-race-b') THEN
    RAISE EXCEPTION 'credit note race %: session B never waited on session A', '${name}';
  END IF;
END \$\$;
COMMIT;
SQL
  a_pid=$!
  local seen=0
  for _ in $(seq 1 400); do
    if grep -q 'a-holding' "$tmp/$name.a.out"; then seen=1; break; fi
    if ! kill -0 "$a_pid" 2>/dev/null; then break; fi
    sleep 0.025
  done
  if [ "$seen" -ne 1 ]; then
    echo "credit note race $name: session A did not copy and hold" >&2
    cat "$tmp/$name.a.out" "$tmp/$name.a.err" >&2
    exit 1
  fi
  PGAPPNAME="cn-race-b" psql "$CONTRACT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
    >"$tmp/$name.b.out" 2>"$tmp/$name.b.err" <<SQL &
SET ROLE service_role;
SELECT 'B:' || public.xero_supplier_credit_note_copy('${ORG}', $(note "$id" "$7" "$8"), $(alloc "$9" "${10}"));
SQL
  b_pid=$!
  if ! wait "$a_pid"; then echo "credit note race $name: session A failed" >&2; cat "$tmp/$name.a.out" "$tmp/$name.a.err" >&2; exit 1; fi
  a_pid=
  if ! wait "$b_pid"; then echo "credit note race $name: session B failed" >&2; cat "$tmp/$name.b.out" "$tmp/$name.b.err" >&2; exit 1; fi
  b_pid=
  echo "$name $(grep -h '^[AB]:' "$tmp/$name.a.out" "$tmp/$name.b.out" | tr '\n' ' ')" >>"$tmp/answers"
}

N1=cccccccc-9000-4000-8000-000000000001
N2=cccccccc-9000-4000-8000-000000000002
N3=cccccccc-9000-4000-8000-000000000003
N4=cccccccc-9000-4000-8000-000000000004
N5=cccccccc-9000-4000-8000-000000000005
BILL_A=bbbbbbbb-9000-4000-8000-00000000000a
BILL_B=bbbbbbbb-9000-4000-8000-00000000000b
: >"$tmp/answers"

race race1 "$N1" 2026-10-02T00:00:00Z newer "$BILL_A" 7  2026-10-01T00:00:00Z older "$BILL_B" 3
copy_now "$N2" 2026-10-01T00:00:00Z seed "$BILL_A" 1
race race2 "$N2" 2026-10-03T00:00:00Z newer "$BILL_A" 9  2026-10-02T00:00:00Z older "$BILL_B" 5
race race3 "$N3" 2026-10-04T00:00:00Z replay "$BILL_A" 4  2026-10-04T00:00:00Z replay "$BILL_A" 4
race race4 "$N4" 2026-10-01T00:00:00Z older "$BILL_A" 2  2026-10-05T00:00:00Z newer "$BILL_B" 6
copy_now "$N5" 2026-10-01T00:00:00Z seed none 0
race race5 "$N5" 2026-10-02T00:00:00Z listed "$BILL_A" 8  2026-10-03T00:00:00Z unlisted none 0

answers=$(cat "$tmp/answers")
echo "$answers"

# One line per race: what is stored now, then the verdict.
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v answers="$answers" <<SQL
CREATE TEMP TABLE cn_race_want (race text, id text, updated timestamptz, mark text, returned boolean, allocs text, answers text);
INSERT INTO cn_race_want VALUES
  ('race1', '${N1}', '2026-10-02T00:00:00Z', 'newer',    true,  '${BILL_A}:7.00',  'race1 A:written B:stale'),
  ('race2', '${N2}', '2026-10-03T00:00:00Z', 'newer',    true,  '${BILL_A}:9.00',  'race2 A:written B:stale'),
  ('race3', '${N3}', '2026-10-04T00:00:00Z', 'replay',   true,  '${BILL_A}:4.00',  'race3 A:written B:written'),
  ('race4', '${N4}', '2026-10-05T00:00:00Z', 'newer',    true,  '${BILL_B}:6.00',  'race4 A:written B:written'),
  ('race5', '${N5}', '2026-10-03T00:00:00Z', 'unlisted', false, '${BILL_A}:8.00',  'race5 A:written B:written');
CREATE TEMP TABLE cn_race_got AS
SELECT w.race,
       n.xero_updated_at AS updated, n.raw_json ->> 'Mark' AS mark, n.allocations_returned AS returned,
       (SELECT string_agg(a.xero_invoice_id || ':' || a.amount, ' ' ORDER BY a.n)
          FROM public.xero_supplier_credit_note_allocations a
         WHERE a.org_id = '${ORG}' AND a.xero_credit_note_id = w.id) AS allocs,
       (SELECT btrim(x) FROM regexp_split_to_table(:'answers', E'\n') x WHERE x LIKE w.race || ' %') AS answers
  FROM cn_race_want w
  LEFT JOIN public.xero_supplier_credit_notes n ON n.org_id = '${ORG}' AND n.xero_credit_note_id = w.id;
SELECT g.race, g.updated, g.mark, g.returned, g.allocs, g.answers,
       CASE WHEN (g.updated, g.mark, g.returned, g.allocs, g.answers) IS NOT DISTINCT FROM (w.updated, w.mark, w.returned, w.allocs, w.answers)
            THEN 'ok' ELSE 'WRONG' END AS verdict
  FROM cn_race_got g JOIN cn_race_want w USING (race) ORDER BY g.race;
DELETE FROM public.xero_supplier_credit_notes WHERE org_id = '${ORG}' AND xero_credit_note_id LIKE 'cccccccc-9000-%';
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM cn_race_got g JOIN cn_race_want w USING (race)
              WHERE (g.updated, g.mark, g.returned, g.allocs, g.answers) IS DISTINCT FROM (w.updated, w.mark, w.returned, w.allocs, w.answers)) THEN
    RAISE EXCEPTION 'credit note race: a concurrent copy lost the newer note or its allocations (%)',
      (SELECT string_agg(g.race, ' ' ORDER BY g.race) FROM cn_race_got g JOIN cn_race_want w USING (race)
        WHERE (g.updated, g.mark, g.returned, g.allocs, g.answers) IS DISTINCT FROM (w.updated, w.mark, w.returned, w.allocs, w.answers));
  END IF;
END \$\$;
SQL
if [ "$made_org" = made ]; then
  psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "DELETE FROM public.organisations WHERE id = '${ORG}'"
fi
echo 'credit note races passed'
