#!/usr/bin/env bash
# Read-only ops-api action-surface smoke check for GitHub Actions.
#
# This intentionally does not use the Supabase CLI. It proves the deployed
# function recognises the required action names by calling each action with the
# normal dashboard API key and failing on "Unknown action".

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-kevgrhcjxspbxgovpmfl}"
BASE="${SUPABASE_FUNCTIONS_BASE:-https://${PROJECT_REF}.supabase.co/functions/v1}"
SW_API_KEY="${SW_API_KEY:?Set SW_API_KEY before running ops-api action-surface smoke checks}"
REQUIRED_ACTIONS_FILE="${REQUIRED_ACTIONS_FILE:-scripts/_ops-api-required-actions.txt}"

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
  elif printf '%s' "$body" | grep -Eqi 'Missing authorization header|Invalid JWT|JWT expired'; then
    record_fail "${label}: gateway/JWT error"
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

echo "== SecureWorks ops-api action-surface smoke =="
echo "Project: ${PROJECT_REF}"

ops_version="$(json_get "${BASE}/ops-api?action=ops_api_version")"
assert_not_unknown "ops-api ops_api_version recognised" "$ops_version"
assert_contains "ops-api canonical source" "$ops_version" '"source_repo":"secureworks-site"'
assert_contains "ops-api version includes build label" "$ops_version" '"build_label":'

if [[ ! -f "$REQUIRED_ACTIONS_FILE" ]]; then
  record_fail "required action manifest missing: ${REQUIRED_ACTIONS_FILE}"
else
  drift=0
  total=0
  while IFS= read -r action; do
    [[ -z "$action" ]] && continue
    total=$((total + 1))
    body="$(json_get "${BASE}/ops-api?action=${action}")"
    if printf '%s' "$body" | grep -Eqi 'Missing authorization header|Invalid JWT|JWT expired'; then
      record_fail "ops-api drift: action '${action}' blocked by gateway/JWT"
      drift=$((drift + 1))
    elif printf '%s' "$body" | grep -qi 'Unknown action'; then
      # Some write handlers only prove recognition on POST. Use an empty body;
      # handlers should fail validation before any business mutation.
      body="$(json_post "${BASE}/ops-api?action=${action}" '{}')"
      if printf '%s' "$body" | grep -Eqi 'Missing authorization header|Invalid JWT|JWT expired'; then
        record_fail "ops-api drift: action '${action}' blocked by gateway/JWT"
        drift=$((drift + 1))
      elif printf '%s' "$body" | grep -qi 'Unknown action'; then
        record_fail "ops-api drift: action '${action}' returns Unknown action"
        drift=$((drift + 1))
      else
        record_pass "ops-api action '${action}' recognised"
      fi
    else
      record_pass "ops-api action '${action}' recognised"
    fi
  done < <(grep -vE '^\s*(#|$)' "$REQUIRED_ACTIONS_FILE" | awk '{print $1}')

  if [[ "$drift" -eq 0 ]]; then
    record_pass "ops-api action-surface: all ${total} required actions recognised"
  fi
fi

echo "== Results: ${PASS} passed, ${FAIL} failed =="
exit "$FAIL"
