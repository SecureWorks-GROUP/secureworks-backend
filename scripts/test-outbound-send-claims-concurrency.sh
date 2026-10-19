#!/usr/bin/env bash
# Two real Postgres sessions claim the same item at the same moment, then two
# sessions reconcile the same unknown attempt at the same moment. Each time
# exactly one wins and the other is refused once the winner commits. Run against
# a disposable local database that already has 20261019170000 applied:
#   OUTBOUND_CLAIMS_DB_URL=postgresql://postgres@127.0.0.1:54329/osc_fwd \
#     bash scripts/test-outbound-send-claims-concurrency.sh
set -euo pipefail
: "${OUTBOUND_CLAIMS_DB_URL:?set OUTBOUND_CLAIMS_DB_URL to a disposable database}"
run=$(date +%s%N)
key="concurrency:$run"
out=$(mktemp -d)
claim() {
  psql -X -q -At -v ON_ERROR_STOP=1 "$OUTBOUND_CLAIMS_DB_URL" <<SQL >"$out/$1"
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.claim_outbound_send(ARRAY['$key'], '$1-$run', 'concurrency-test', '{}'::jsonb, 600)->>'code';
SELECT pg_sleep(1.5);
COMMIT;
SQL
}
claim attempt-a & pa=$!
claim attempt-b & pb=$!
wait "$pa" "$pb"
a=$(head -1 "$out/attempt-a"); b=$(head -1 "$out/attempt-b")
rows=$(psql -X -q -At "$OUTBOUND_CLAIMS_DB_URL" -c "SELECT count(*) FROM public.outbound_send_claims WHERE item_key = '$key'")
echo "attempt-a: ${a:-claimed}  attempt-b: ${b:-claimed}  rows: $rows"
held=0; won=0
for v in "$a" "$b"; do
  if [ "$v" = "send_claim_held" ]; then held=$((held + 1)); elif [ -z "$v" ]; then won=$((won + 1)); fi
done
if [ "$won" -ne 1 ] || [ "$held" -ne 1 ] || [ "$rows" -ne 1 ]; then
  echo "FAIL: two concurrent claims did not resolve to one winner" >&2
  exit 1
fi
echo "PASS: one claim won, the other was refused"

# Settle the winner as unknown, then race two "Sent Items checked" presses.
winner=attempt-a; [ -z "$b" ] && winner=attempt-b
psql -X -q -At -v ON_ERROR_STOP=1 "$OUTBOUND_CLAIMS_DB_URL" \
  -c "SET ROLE service_role; SELECT public.settle_outbound_send('$winner-$run', 'outcome_unknown', '{}'::jsonb)" >/dev/null
reconcile() {
  psql -X -q -At -v ON_ERROR_STOP=1 "$OUTBOUND_CLAIMS_DB_URL" <<SQL >"$out/$1"
BEGIN;
SET LOCAL ROLE service_role;
SELECT coalesce(public.reconcile_outbound_send('$winner-$run', 'outcome_unknown', 'not_sent', '$1', now(), 'checked')->>'code', 'ok');
SELECT pg_sleep(1.5);
COMMIT;
SQL
}
reconcile office-a & ra=$!
reconcile office-b & rb=$!
wait "$ra" "$rb"
x=$(head -1 "$out/office-a"); y=$(head -1 "$out/office-b")
echo "office-a: $x  office-b: $y"
if [ "$(printf '%s\n%s\n' "$x" "$y" | sort | tr '\n' ' ')" != "ok send_reconcile_state_changed " ]; then
  echo "FAIL: two concurrent reconciles did not resolve to one winner" >&2
  exit 1
fi
echo "PASS: one reconcile won, the other was refused"
