#!/bin/bash
# Prove production SQL RPCs via booking_test transport. Not a deploy path.
set -euo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
PSQL=(psql -h 127.0.0.1 -p 55581 -U marninstobbe -d booking_test -v ON_ERROR_STOP=1 -Atq)
sql() { "${PSQL[@]}" -c "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

"${PSQL[@]}" -f /Users/marninstobbe/Projects/secureworks-backend-sales-booking/supabase/migrations/20260913000003_sales_booking_tenant_rls.sql >/dev/null
ORG='00000000-0000-0000-0000-000000000001'

RUN="rpc$(date +%s)"
A="2026-09-17T13:00:00+08:00"
B="2026-09-17T13:30:00+08:00"
C="2026-09-17T13:15:00+08:00"
D="2026-09-17T13:45:00+08:00"
E="2026-09-17T14:00:00+08:00"

RES="res-$RUN"
sql "INSERT INTO sales_booking_cases (id, resource_id, status) VALUES ('ca-$RUN','$RES','ready'), ('cb-$RUN','$RES','ready') ON CONFLICT DO NOTHING;"

R1=$(sql "SELECT sales_booking_claim_slot('$ORG'::uuid,'cl1-$RUN','$RES','$A','$B','ca-$RUN')->>'ok';")
R2=$(sql "SELECT sales_booking_claim_slot('$ORG'::uuid,'cl2-$RUN','$RES','$C','$D','cb-$RUN')->>'code';")
[ "$R1" = "true" ] || fail "first claim $R1"
[ "$R2" = "slot_overlap" ] || fail "overlap expected, got $R2"
pass "13:00-13:30 overlaps 13:15-13:45"

R3=$(sql "SELECT sales_booking_claim_slot('$ORG'::uuid,'cl3-$RUN','$RES','$B','$E','cb-$RUN')->>'ok';")
[ "$R3" = "true" ] || fail "adjacent half-open range should succeed, got $R3"
pass "13:30-14:00 adjacent to 13:00-13:30"

L1=$(sql "SELECT sales_booking_acquire_lease('$ORG'::uuid,'ls1-$RUN','ca-$RUN','assess','tok-a-$RUN','w1',60)->>'ok';")
L2=$(sql "SELECT sales_booking_acquire_lease('$ORG'::uuid,'ls2-$RUN','ca-$RUN','assess','tok-b-$RUN','w2',60)->>'code';")
[ "$L1" = "true" ] || fail "lease1"
[ "$L2" = "lease_held" ] || fail "lease fence $L2"
pass "worker leases distinct from occupancy"

sql "INSERT INTO sales_booking_cases (id, resource_id, source_version) VALUES ('cas-$RUN','nithin','v1') ON CONFLICT (id) DO UPDATE SET source_version='v1';"
CAS1=$(sql "SELECT sales_booking_cas_case('$ORG'::uuid,'cas-$RUN','v1','v2',NULL)->>'ok';")
CAS2=$(sql "SELECT sales_booking_cas_case('$ORG'::uuid,'cas-$RUN','v1','v3',NULL)->>'code';")
[ "$CAS1" = "true" ] || fail "cas first"
[ "$CAS2" = "cas_conflict" ] || fail "stale cas $CAS2"
pass "CAS stale-source fence"

E1=$(sql "SELECT sales_booking_ingest_event('$ORG'::uuid,'evt-$RUN')->>'processed';")
E2=$(sql "SELECT sales_booking_ingest_event('$ORG'::uuid,'evt-$RUN')->>'retry';")
[ "$E1" = "false" ] || fail "first ingest processed $E1"
[ "$E2" = "true" ] || fail "unprocessed retry $E2"
pass "event ingest retry until processed"

CUR=$(sql "SELECT sales_booking_put_consumption_cursor('$ORG'::uuid,'ghl-provider:x','{\"a\":1}'::jsonb)->>'code';")
[ "$CUR" = "not_consumption_cursor" ] || fail "provider cursor leaked into booking $CUR"
OKC=$(sql "SELECT sales_booking_put_consumption_cursor('$ORG'::uuid,'consume:nithin:2026-09-14','{\"complete\":false}'::jsonb)->>'ok';")
[ "$OKC" = "true" ] || fail "consumption cursor"
pass "workflow consumption cursors only"

OTHER=$(psql -h 127.0.0.1 -p 55581 -U marninstobbe -d postgres -Atq -c \
  "SELECT COUNT(*) FROM pg_database WHERE datname IN ('postgres','dispatch_test2','dispatch_test3','dispatch_test4','dispatch_ui');")
[ "$OTHER" = "5" ] || fail "other databases"
pass "cluster databases preserved"

echo "ALL SQL RPC PROOFS PASSED"
