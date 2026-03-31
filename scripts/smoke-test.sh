#!/bin/bash
# SecureWorks Smoke Test — hit every edge function and verify 200 response
# Usage: SW_API_KEY="your-key" bash scripts/smoke-test.sh

set -euo pipefail

API_KEY="${SW_API_KEY:?Set SW_API_KEY env var}"
BASE="https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1"
PASS=0
FAIL=0

check() {
  local name="$1" url="$2" method="${3:-GET}" body="${4:-}"
  local status
  if [ "$method" = "POST" ] && [ -n "$body" ]; then
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url" \
      -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
      -d "$body" --max-time 30)
  else
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url" \
      -H "x-api-key: $API_KEY" -H "Content-Type: application/json" --max-time 30)
  fi
  if [ "$status" = "200" ]; then
    echo "  PASS  $name ($status)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name ($status)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== SecureWorks Smoke Test ==="
echo ""

echo "── Core Functions ──"
check "ops-api (ops_summary)" "$BASE/ops-api?action=ops_summary"
check "ops-ai (ping)" "$BASE/ops-ai" "POST" '{"messages":[{"role":"user","content":"ping"}],"view":"ops"}'
check "reporting-api (dashboard_summary)" "$BASE/reporting-api?action=dashboard_summary"
check "ghl-proxy (search)" "$BASE/ghl-proxy?action=search&q=test"
check "daily-digest (nudge_check)" "$BASE/daily-digest?action=nudge_check"
check "system-health" "$BASE/system-health" "POST" '{}'

echo ""
echo "── Spine: Expenses ──"
check "list_expenses" "$BASE/ops-api?action=list_expenses"
check "list_unreconciled_transactions" "$BASE/ops-api?action=list_unreconciled_transactions"

echo ""
echo "── Spine: Council ──"
check "list_council_submissions" "$BASE/ops-api?action=list_council_submissions"

echo ""
echo "── Spine: Variations ──"
check "list_variations" "$BASE/ops-api?action=list_variations"

echo ""
echo "── Spine: Duration ──"
check "check_job_durations" "$BASE/ops-api?action=check_job_durations"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && echo "All clear!" || echo "Some endpoints need attention."
exit "$FAIL"
