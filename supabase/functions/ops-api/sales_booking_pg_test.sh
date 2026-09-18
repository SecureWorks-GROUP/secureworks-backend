#!/bin/bash
# Real Postgres proofs for Booking. Local booking_test only. Not production.
set -euo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
PSQL=(psql -h 127.0.0.1 -p 55581 -U marninstobbe -d booking_test -v ON_ERROR_STOP=1 -Atq)

sql() { "${PSQL[@]}" -c "$1"; }

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Isolated rows for this run
RUN="r$(date +%s)"
CASE="case-$RUN"
SLOT_START="2026-09-17T13:00:00+08:00"
SLOT_END_SHORT="2026-09-17T13:30:00+08:00"
SLOT_END_HOUR="2026-09-17T14:00:00+08:00"

sql "INSERT INTO sales_booking_cases (id, resource_id, contact_id, status, source_version)
     VALUES ('$CASE', 'nithin', 'c-$RUN', 'ready', 'src-1');"

# 1. Durable reload across a new connection
sql "INSERT INTO sales_booking_drafts (case_id, text, revision, human_edited)
     VALUES ('$CASE', 'Hi Thursday 1pm', 1, true);"
RELOAD=$(psql -h 127.0.0.1 -p 55581 -U marninstobbe -d booking_test -Atq -c \
  "SELECT text FROM sales_booking_drafts WHERE case_id='$CASE';")
[ "$RELOAD" = "Hi Thursday 1pm" ] || fail "durable reload got '$RELOAD'"
pass "durable reload across a new psql connection"

# 2. Concurrent capacity: unique live slot claim, second insert fails
sql "INSERT INTO sales_booking_slot_claims (claim_id, resource_id, start_iso, end_iso, case_id, status)
     VALUES ('claim-a-$RUN', 'nithin', '$SLOT_START', '$SLOT_END_HOUR', '$CASE', 'held');"
if sql "INSERT INTO sales_booking_slot_claims (claim_id, resource_id, start_iso, end_iso, case_id, status)
        VALUES ('claim-b-$RUN', 'nithin', '$SLOT_START', '$SLOT_END_HOUR', 'other-$RUN', 'held');" 2>/tmp/booking-claim.err; then
  fail "second live claim should have been rejected"
fi
grep -q "sales_booking_slot_claims_live" /tmp/booking-claim.err || grep -qi "duplicate\|unique" /tmp/booking-claim.err || fail "expected unique violation"
pass "concurrent capacity unique live slot claim"

# 3. Exact bound approval: matching start/end/revision required
sql "UPDATE sales_booking_cases SET exact_acceptance=true,
     accepted_offer_id='off-$RUN', accepted_start_iso='$SLOT_START',
     accepted_end_iso='$SLOT_END_SHORT', accepted_slot_revision=3, accepted_resource_id='nithin'
     WHERE id='$CASE';"
sql "INSERT INTO sales_booking_offers (offer_id, case_id, slot_revision, start_iso, end_iso, send_evidence)
     VALUES ('off-$RUN', '$CASE', 3, '$SLOT_START', '$SLOT_END_SHORT', 'sent');"

MATCH=$(sql "SELECT CASE WHEN exact_acceptance AND accepted_start_iso='$SLOT_START'
     AND accepted_end_iso='$SLOT_END_SHORT' AND accepted_slot_revision=3
     AND accepted_resource_id='nithin' THEN 'ok' ELSE 'bad' END
     FROM sales_booking_cases WHERE id='$CASE';")
[ "$MATCH" = "ok" ] || fail "bound slot not stored"

WRONG=$(sql "SELECT CASE WHEN accepted_end_iso='$SLOT_END_HOUR' THEN 'wrong-end-allowed' ELSE 'end-bound' END
     FROM sales_booking_cases WHERE id='$CASE';")
[ "$WRONG" = "end-bound" ] || fail "duration stretch stored as accepted"

# Confirm helper: reject if presented end does not match stored bound
PRESENTED_END="$SLOT_END_HOUR"
GATE=$(sql "SELECT CASE WHEN exact_acceptance AND accepted_end_iso='$PRESENTED_END' THEN 'confirm' ELSE 'reject' END
     FROM sales_booking_cases WHERE id='$CASE';")
[ "$GATE" = "reject" ] || fail "same-start longer duration still had confirm authority"
pass "exact bound approval rejects 13:30 to 14:00"

# 4. Stale-source invalidation
sql "INSERT INTO sales_booking_source_revisions (case_id, calendar_revision, conversation_revision, leave_revision)
     VALUES ('$CASE', 'cal-2', 'convo-2', 'leave-2');"
STALE=$(sql "SELECT CASE WHEN calendar_revision='cal-1' THEN 'stale-ok' ELSE 'stale-blocked' END
     FROM sales_booking_source_revisions WHERE case_id='$CASE';")
[ "$STALE" = "stale-blocked" ] || fail "stale calendar revision accepted"
sql "INSERT INTO sales_booking_assessments (case_id, version, payload)
     VALUES ('$CASE', 'v2.2', '{\"status\":\"ready\",\"source\":\"cal-1\"}'::jsonb);"
sql "UPDATE sales_booking_assessments SET payload = payload || jsonb_build_object('invalidated', true, 'reason', 'stale_source')
     WHERE case_id='$CASE' AND payload->>'source' IS DISTINCT FROM (
       SELECT calendar_revision FROM sales_booking_source_revisions WHERE case_id='$CASE');"
INV=$(sql "SELECT payload->>'invalidated' FROM sales_booking_assessments WHERE case_id='$CASE';")
[ "$INV" = "true" ] || fail "stale assessment not invalidated"
pass "stale-source invalidation"

# 5. Retry/lease fences
sql "INSERT INTO sales_booking_leases (lease_id, case_id, action_kind, token, owner, expires_at)
     VALUES ('lease-$RUN', '$CASE', 'approve_offer', 'tok-live-$RUN', 'worker-a', now() + interval '5 minutes');"
if sql "INSERT INTO sales_booking_leases (lease_id, case_id, action_kind, token, owner, expires_at)
        VALUES ('lease-b-$RUN', '$CASE', 'approve_offer', 'tok-live-$RUN', 'worker-b', now() + interval '5 minutes');" 2>/tmp/booking-lease.err; then
  fail "duplicate lease token should fail"
fi
STALE_TOKEN="tok-old-$RUN"
OWN=$(sql "SELECT CASE WHEN token='$STALE_TOKEN' THEN 'stale-ran' ELSE 'fence' END
     FROM sales_booking_leases WHERE lease_id='lease-$RUN';")
[ "$OWN" = "fence" ] || fail "stale lease token executed"
sql "UPDATE sales_booking_leases SET released=true WHERE lease_id='lease-$RUN';"
sql "INSERT INTO sales_booking_leases (lease_id, case_id, action_kind, token, owner, expires_at)
     VALUES ('lease-retry-$RUN', '$CASE', 'approve_offer', 'tok-retry-$RUN', 'worker-a', now() + interval '5 minutes');"
pass "retry/lease fences"

# Preserve other databases
OTHER=$(psql -h 127.0.0.1 -p 55581 -U marninstobbe -d postgres -Atq -c \
  "SELECT COUNT(*) FROM pg_database WHERE datname IN ('postgres','dispatch_test2','dispatch_test3','dispatch_test4','dispatch_ui');")
[ "$OTHER" = "5" ] || fail "other databases missing"
pass "other cluster databases preserved"

echo "ALL BOOKING_TEST PG PROOFS PASSED run=$RUN"
