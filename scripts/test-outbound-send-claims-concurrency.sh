#!/usr/bin/env bash
# Real concurrent Postgres sessions against the outbound send claim doors. Each
# race holds its transaction open after its call, so the other session either
# runs alongside it or waits on the attempt's advisory lock, as two edge
# function calls would. Every race must resolve to exactly one winner.
#   1. two claims of one item;
#   2. two "Sent Items checked" reconciles of one unknown attempt;
#   3. two extends of one attempt (same content, then different content);
#   4. a door's extend against its caller's settle, in both orders;
#   5. a reconcile against a late pre-send confirm, in both orders.
# Run against a disposable local database that already has 20261019170000
# applied, connecting as its owner (the script lapses one lease directly):
#   OUTBOUND_CLAIMS_DB_URL=postgresql://postgres@127.0.0.1:54329/osc_fwd \
#     bash scripts/test-outbound-send-claims-concurrency.sh
set -euo pipefail
: "${OUTBOUND_CLAIMS_DB_URL:?set OUTBOUND_CLAIMS_DB_URL to a disposable database}"
run=$(date +%s%N)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

sql() {
  psql -X -q -At -v ON_ERROR_STOP=1 "$OUTBOUND_CLAIMS_DB_URL" -c "$1"
}

# session NAME SQL: run SQL as service_role in one transaction held 1.5 s
# after the call; NAME holds the first output line and NAME.ms the elapsed time.
session() {
  local name=$1 body=$2 start
  start=$(date +%s%N)
  psql -X -q -At -v ON_ERROR_STOP=1 "$OUTBOUND_CLAIMS_DB_URL" >"$out/$name" <<SQL
BEGIN;
SET LOCAL ROLE service_role;
$body;
SELECT pg_sleep(1.5);
COMMIT;
SQL
  echo $(( ($(date +%s%N) - start) / 1000000 )) >"$out/$name.ms"
}

# race A_NAME A_SQL B_NAME B_SQL [STAGGER]: start both; B starts STAGGER
# seconds after A (0 = together).
race() {
  session "$1" "$2" & local pa=$!
  sleep "${5:-0}"
  session "$3" "$4" & local pb=$!
  wait "$pa" "$pb"
}

first() { head -1 "$out/$1"; }
ms() { cat "$out/$1.ms"; }
code() { echo "coalesce(($1)->>'code', CASE WHEN (($1)->>'deferred')::boolean THEN 'deferred' ELSE 'ok' END)"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
pair() { printf '%s\n%s\n' "$1" "$2" | sort | tr '\n' ' ' | sed 's/ $//'; }
claim() {
  sql "SET ROLE service_role; SELECT public.claim_outbound_send(ARRAY['$1'], '$2', 'concurrency-test', '{}'::jsonb)->>'dispatch_token'"
}

# 1. Two claims of one item.
key="concurrency:$run"
race claim-a "SELECT $(code "public.claim_outbound_send(ARRAY['$key'], 'claim-a-$run', 'concurrency-test', '{}'::jsonb)")" \
     claim-b "SELECT $(code "public.claim_outbound_send(ARRAY['$key'], 'claim-b-$run', 'concurrency-test', '{}'::jsonb)")"
a=$(first claim-a); b=$(first claim-b)
rows=$(sql "SELECT count(*) FROM public.outbound_send_claims WHERE item_key = '$key'")
echo "1 claim race:        claim-a $a, claim-b $b, rows $rows"
[ "$(pair "$a" "$b")" = "ok send_claim_held" ] && [ "$rows" -eq 1 ] || fail "two concurrent claims did not resolve to one winner"
echo "PASS: one claim won, the other was refused"

# 2. Two reconciles of one unknown attempt.
winner=claim-a; [ "$b" = ok ] && winner=claim-b
sql "SET ROLE service_role; SELECT public.settle_outbound_send('$winner-$run', 'outcome_unknown', '{}'::jsonb)" >/dev/null
rec="public.reconcile_outbound_send('$winner-$run', 'outcome_unknown', 'not_sent', 'office', now(), 'checked')"
race office-a "SELECT $(code "$rec")" office-b "SELECT $(code "$rec")"
x=$(first office-a); y=$(first office-b)
echo "2 reconcile race:    office-a $x, office-b $y"
[ "$(pair "$x" "$y")" = "ok send_reconcile_state_changed" ] || fail "two concurrent reconciles did not resolve to one winner"
echo "PASS: one reconcile won, the other was refused"

# 3. Two extends of one attempt carrying the same caller attempt.
for variant in same different; do
  attempt="extend-$variant-$run"
  claim "invoice:$attempt" "$attempt" >/dev/null
  ka="email_content:$attempt"; kb="$ka"; [ "$variant" = different ] && kb="email_content:$attempt-other"
  race door-a "SELECT $(code "public.extend_outbound_send_claim('$attempt', ARRAY['$ka'], 'invoice:$attempt')")" \
       door-b "SELECT $(code "public.extend_outbound_send_claim('$attempt', ARRAY['$kb'], 'invoice:$attempt')")"
  x=$(first door-a); y=$(first door-b)
  tokens=$(sql "SELECT count(DISTINCT dispatch_token) FROM public.outbound_send_claims WHERE attempt_id = '$attempt'")
  rows=$(sql "SELECT count(*) FROM public.outbound_send_claims WHERE attempt_id = '$attempt'")
  echo "3 extend race ($variant content): door-a $x, door-b $y, rows $rows, tokens $tokens"
  [ "$(pair "$x" "$y")" = "ok send_claim_dispatch_taken" ] && [ "$rows" -eq 2 ] && [ "$tokens" -eq 1 ] \
    || fail "two concurrent extends of one attempt did not resolve to one dispatch"
done
echo "PASS: one extend took the dispatch, the other was refused"

# 4. A door's extend against its caller's settle.
attempt="extend-settle-$run"
claim "invoice:$attempt" "$attempt" >/dev/null
race door "SELECT $(code "public.extend_outbound_send_claim('$attempt', ARRAY['email_content:$attempt'], 'invoice:$attempt')")" \
     caller "SELECT $(code "public.settle_outbound_send('$attempt', 'outcome_unknown', '{}'::jsonb, 'caller')")" 0.4
x=$(first door); y=$(first caller)
states=$(sql "SELECT string_agg(DISTINCT state, ',') FROM public.outbound_send_claims WHERE attempt_id = '$attempt'")
echo "4 extend then settle: door $x, caller $y (waited $(ms caller) ms), states $states"
[ "$x" = ok ] && [ "$y" = deferred ] && [ "$states" = sending ] && [ "$(ms caller)" -ge 1400 ] \
  || fail "a caller settle racing its door's extend was not deferred behind it"
attempt="settle-extend-$run"
claim "invoice:$attempt" "$attempt" >/dev/null
race caller "SELECT $(code "public.settle_outbound_send('$attempt', 'outcome_unknown', '{}'::jsonb, 'caller')")" \
     door "SELECT $(code "public.extend_outbound_send_claim('$attempt', ARRAY['email_content:$attempt'], 'invoice:$attempt')")" 0.4
x=$(first caller); y=$(first door)
rows=$(sql "SELECT count(*) FROM public.outbound_send_claims WHERE attempt_id = '$attempt'")
echo "4 settle then extend: caller $x, door $y (waited $(ms door) ms), rows $rows"
[ "$x" = ok ] && [ "$y" = send_claim_not_sending ] && [ "$rows" -eq 1 ] \
  || fail "a door extend after its caller settled was not refused"
echo "PASS: extend and caller settle serialise; the loser defers or is refused"

# 5. A reconcile against a late pre-send confirm.
attempt="reconcile-confirm-$run"
token=$(claim "invoice:$attempt" "$attempt")
sql "UPDATE public.outbound_send_claims SET lease_until = now() - interval '1 second' WHERE attempt_id = '$attempt'" >/dev/null
race office "SELECT $(code "public.reconcile_outbound_send('$attempt', 'sending', 'not_sent', 'office', now(), 'checked')")" \
     worker "SELECT $(code "public.confirm_outbound_dispatch('$attempt', '$token')")" 0.4
x=$(first office); y=$(first worker)
echo "5 reconcile then confirm: office $x, worker $y (waited $(ms worker) ms)"
[ "$x" = ok ] && [ "$y" = send_dispatch_fenced ] || fail "a late confirm after a reconcile was not fenced"
attempt="confirm-reconcile-$run"
token=$(claim "invoice:$attempt" "$attempt")
race worker "SELECT $(code "public.confirm_outbound_dispatch('$attempt', '$token')")" \
     office "SELECT $(code "public.reconcile_outbound_send('$attempt', 'sending', 'not_sent', 'office', now(), 'checked')")" 0.4
x=$(first worker); y=$(first office)
echo "5 confirm then reconcile: worker $x, office $y (waited $(ms office) ms)"
[ "$x" = ok ] && [ "$y" = send_reconcile_live_send ] || fail "a reconcile released a send its worker had just confirmed"
echo "PASS: confirm and reconcile serialise; a reconciled send is fenced and a live one is never released"
