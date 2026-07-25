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
CURL_BIN="${CURL_BIN:-curl}"

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
  "$CURL_BIN" -sS --max-time 30 -H "x-api-key: ${SW_API_KEY}" -H "Content-Type: application/json" "$url"
}

json_post() {
  local url="$1"
  local body="${2:-{}}"
  "$CURL_BIN" -sS --max-time 30 -X POST -H "x-api-key: ${SW_API_KEY}" -H "Content-Type: application/json" -d "$body" "$url"
}

action_probe_url() {
  local action="$1"
  case "$action" in
    makesafe_deterministic_intake_replay)
      # Recognition must never launch the 60-day / 500-source default replay.
      # Dry-run still advances only its observe cursor, so keep this probe tiny.
      printf '%s/ops-api?action=%s&days=1&max_sources=1' "$BASE" "$action"
      ;;
    *)
      printf '%s/ops-api?action=%s' "$BASE" "$action"
      ;;
  esac
}

is_jwt_read_only_action() {
  case "$1" in
    trade_calendar | my_jobs | my_work_orders | submit_work_order_invoice)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_get_only_action() {
  case "$1" in
    makesafe_deterministic_intake_replay | trade_calendar | my_jobs | my_work_orders | submit_work_order_invoice)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
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
    probe_url="$(action_probe_url "$action")"
    body="$(json_get "$probe_url")"
    if printf '%s' "$body" | grep -Eqi 'Missing authorization header|Invalid JWT|JWT expired'; then
      record_fail "ops-api drift: action '${action}' blocked by gateway/JWT"
      drift=$((drift + 1))
    elif printf '%s' "$body" | grep -qi 'Unknown action'; then
      if is_get_only_action "$action"; then
        record_fail "ops-api drift: read-only probe for action '${action}' returns Unknown action"
        drift=$((drift + 1))
      else
        # Some write handlers only prove recognition on POST. Use an empty body;
        # handlers should fail validation before any business mutation.
        body="$(json_post "$probe_url" '{}')"
        if printf '%s' "$body" | grep -Eqi 'Missing authorization header|Invalid JWT|JWT expired'; then
          record_fail "ops-api drift: action '${action}' blocked by gateway/JWT"
          drift=$((drift + 1))
        elif printf '%s' "$body" | grep -qi 'Unknown action'; then
          record_fail "ops-api drift: action '${action}' returns Unknown action"
          drift=$((drift + 1))
        else
          record_pass "ops-api action '${action}' recognised"
        fi
      fi
    elif is_jwt_read_only_action "$action" &&
      ! printf '%s' "$body" | grep -Eqi '"error"[[:space:]]*:[[:space:]]*"Login required"'; then
      record_fail "ops-api drift: JWT action '${action}' did not fail closed at authentication"
      drift=$((drift + 1))
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
