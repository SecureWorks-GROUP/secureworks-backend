#!/usr/bin/env bash
# SecureWorks production edge-function smoke checks.
#
# Read-only/validation-only checks. This script intentionally uses missing or
# invalid payloads for mutating routes so it proves action recognition without
# creating business records, sending messages, or touching customer state.

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-kevgrhcjxspbxgovpmfl}"
BASE="${SUPABASE_FUNCTIONS_BASE:-https://${PROJECT_REF}.supabase.co/functions/v1}"
SUPABASE_CLI="${SUPABASE_CLI:-/Users/marninstobbe/.local/bin/supabase}"
SW_API_KEY="${SW_API_KEY:?Set SW_API_KEY before running smoke checks}"

PASS=0
FAIL=0

record_pass() {
  echo "PASS $1"
  PASS=$((PASS + 1))
}

record_fail() {
  echo "FAIL $1"
  FAIL=$((FAIL + 1))
}

json_get() {
  local url="$1"
  curl -sS --max-time 30 -H "x-api-key: ${SW_API_KEY}" -H "Content-Type: application/json" "$url"
}

json_post() {
  local url="$1"
  local body="${2:-{}}"
  curl -sS --max-time 30 -X POST -H "x-api-key: ${SW_API_KEY}" -H "Content-Type: application/json" -d "$body" "$url"
}

assert_not_unknown() {
  local label="$1"
  local body="$2"
  if printf '%s' "$body" | grep -qi 'Unknown action'; then
    record_fail "${label}: Unknown action"
  else
    record_pass "${label}"
  fi
}

assert_contains() {
  local label="$1"
  local body="$2"
  local needle="$3"
  if printf '%s' "$body" | grep -q "$needle"; then
    record_pass "${label}"
  else
    record_fail "${label}: missing ${needle}"
  fi
}

assert_function_jwt() {
  local slug="$1"
  local expected="$2"
  local actual
  actual="$("${SUPABASE_CLI}" functions list --project-ref "${PROJECT_REF}" -o json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); const f=j.find(x=>(x.slug||x.name)==='${slug}'); if(!f) process.exit(2); console.log(String(f.verify_jwt));})")"
  if [[ "$actual" == "$expected" ]]; then
    record_pass "${slug} verify_jwt=${actual}"
  else
    record_fail "${slug} verify_jwt=${actual}, expected ${expected}"
  fi
}

echo "== SecureWorks Edge Smoke =="
echo "Project: ${PROJECT_REF}"

assert_function_jwt "ops-api" "false"
assert_function_jwt "send-quote" "false"

ops_version="$(json_get "${BASE}/ops-api?action=ops_api_version")"
assert_not_unknown "ops-api ops_api_version recognised" "$ops_version"
assert_contains "ops-api canonical source" "$ops_version" '"source_repo":"secureworks-site"'

for action in \
  list_proposed_actions \
  list_stale_quote_review_tasks \
  finance_health_summary \
  daily_coverage_audit \
  get_evidence_health
do
  body="$(json_get "${BASE}/ops-api?action=${action}")"
  assert_not_unknown "ops-api ${action}" "$body"
done

for action in \
  send_quote_followup_sms \
  approve_scoper_call_task \
  approve_quote_review_task \
  freeze_scope \
  record_scope_artifact
do
  body="$(json_post "${BASE}/ops-api?action=${action}" '{}')"
  assert_not_unknown "ops-api ${action} validation" "$body"
done

quote_view_code="$(curl -sS -o /tmp/send_quote_view_smoke.out -w '%{http_code}' --max-time 30 --max-redirs 0 "${BASE}/send-quote/view?token=definitely-invalid" || true)"
if [[ "$quote_view_code" == "401" ]]; then
  record_fail "send-quote /view blocked by gateway"
else
  record_pass "send-quote /view reaches function/static redirect path (${quote_view_code})"
fi

send_runs_body="$(json_post "${BASE}/send-quote/send-runs" '{}')"
if printf '%s' "$send_runs_body" | grep -qi 'Missing authorization header'; then
  record_fail "send-quote /send-runs blocked by gateway"
else
  record_pass "send-quote /send-runs reaches in-handler validation"
fi

echo "== Results: ${PASS} passed, ${FAIL} failed =="
exit "$FAIL"
