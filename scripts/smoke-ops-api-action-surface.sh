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
# Per-request ceiling. A request that exceeds this is a recorded failure for that
# action, never a fatal abort of the whole sweep.
CURL_MAX_TIME="${CURL_MAX_TIME:-30}"
# Actions slower than this are reported at the end so a creeping regression is
# visible before it becomes a timeout.
SLOW_SECONDS="${SLOW_SECONDS:-10}"

PASS=0
FAIL=0
SLOW_REPORT=""

record_pass() {
  echo "PASS $1"
  PASS=$((PASS + 1))
}

record_fail() {
  echo "FAIL $1"
  FAIL=$((FAIL + 1))
}

# Transport failures (timeout=28, connection reset, DNS) must NOT be fatal.
#
# These helpers are called as `body="$(json_get ...)"`. Under `set -e` a non-zero
# curl inside a command substitution aborted the ENTIRE script on the spot, so one
# slow action killed the sweep with a bare "Process completed with exit code 28",
# no results summary, and no indication of WHICH action stalled. The script's own
# record_fail path could never run for the one failure mode most likely to occur.
#
# Instead, swallow the curl status and emit a marker the callers turn into a named
# failure, so the sweep always completes and always names the offender.
_curl_capture() {
  local out rc=0
  out="$("$@" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'CURL_ERROR rc=%s %s' "$rc" "$out"
  else
    printf '%s' "$out"
  fi
}

# Timing must happen in the CALLER, not inside json_get. These helpers are invoked
# as `body="$(json_get ...)"`, and a command substitution runs in a subshell, so a
# duration assigned in there is discarded when the subshell exits.
TIMER_T0=0
timer_start() { TIMER_T0="$(date -u +%s)"; }
timer_elapsed() { printf '%s' "$(($(date -u +%s) - TIMER_T0))"; }

json_get() {
  local url="$1"
  _curl_capture curl -sS --max-time "$CURL_MAX_TIME" \
    -H "x-api-key: ${SW_API_KEY}" -H "Content-Type: application/json" "$url"
}

json_post() {
  local url="$1"
  local body="${2:-{}}"
  _curl_capture curl -sS --max-time "$CURL_MAX_TIME" -X POST \
    -H "x-api-key: ${SW_API_KEY}" -H "Content-Type: application/json" -d "$body" "$url"
}

curl_errored() {
  case "$1" in
  "CURL_ERROR rc="*) return 0 ;;
  *) return 1 ;;
  esac
}

# Render a transport failure in terms an operator can act on. curl 28 is the one
# that has actually bitten us, so name it explicitly.
curl_error_detail() {
  local rc
  rc="$(printf '%s' "$1" | sed -n 's/^CURL_ERROR rc=\([0-9]*\).*/\1/p')"
  case "$rc" in
  28) printf 'TIMEOUT after %ss (curl 28) — the action did not respond in time' "$CURL_MAX_TIME" ;;
  6) printf 'DNS failure (curl 6)' ;;
  7) printf 'connection refused (curl 7)' ;;
  35 | 60) printf 'TLS failure (curl %s)' "$rc" ;;
  *) printf 'transport failure (curl %s)' "${rc:-unknown}" ;;
  esac
}

note_duration() {
  local label="$1" secs="$2"
  if [ "$secs" -ge "$SLOW_SECONDS" ]; then
    echo "  SLOW ${label}: ${secs}s"
    SLOW_REPORT="${SLOW_REPORT}  ${secs}s  ${label}"$'\n'
  fi
}

assert_not_unknown() {
  local label="$1"
  local body="$2"
  if curl_errored "$body"; then
    record_fail "${label}: $(curl_error_detail "$body")"
  elif printf '%s' "$body" | grep -qi 'Unknown action'; then
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
  if curl_errored "$body"; then
    record_fail "${label}: $(curl_error_detail "$body")"
  elif printf '%s' "$body" | grep -q "$needle"; then
    record_pass "${label}"
  else
    record_fail "${label}: missing ${needle}"
  fi
}

echo "== SecureWorks ops-api action-surface smoke =="
echo "Project: ${PROJECT_REF}"

timer_start
ops_version="$(json_get "${BASE}/ops-api?action=ops_api_version")"
note_duration "ops_api_version" "$(timer_elapsed)"
assert_not_unknown "ops-api ops_api_version recognised" "$ops_version"
assert_contains "ops-api canonical source" "$ops_version" '"source_repo":"secureworks-site"'
assert_contains "ops-api version includes build label" "$ops_version" '"build_label":'

if [[ ! -f "$REQUIRED_ACTIONS_FILE" ]]; then
  record_fail "required action manifest missing: ${REQUIRED_ACTIONS_FILE}"
else
  drift=0
  transport=0
  total=0
  while IFS= read -r action; do
    [[ -z "$action" ]] && continue
    total=$((total + 1))
    timer_start
    body="$(json_get "${BASE}/ops-api?action=${action}")"
    note_duration "${action}" "$(timer_elapsed)"
    if curl_errored "$body"; then
      # Unreachable is not the same as missing. Record it as its own class so the
      # summary never claims the surface was verified when it was not.
      record_fail "ops-api unreachable: action '${action}' $(curl_error_detail "$body")"
      transport=$((transport + 1))
    elif printf '%s' "$body" | grep -Eqi 'Missing authorization header|Invalid JWT|JWT expired'; then
      record_fail "ops-api drift: action '${action}' blocked by gateway/JWT"
      drift=$((drift + 1))
    elif printf '%s' "$body" | grep -qi 'Unknown action'; then
      # Some write handlers only prove recognition on POST. Use an empty body;
      # handlers should fail validation before any business mutation.
      timer_start
      body="$(json_post "${BASE}/ops-api?action=${action}" '{}')"
      note_duration "${action} (POST)" "$(timer_elapsed)"
      if curl_errored "$body"; then
        record_fail "ops-api unreachable: action '${action}' $(curl_error_detail "$body")"
        transport=$((transport + 1))
      elif printf '%s' "$body" | grep -Eqi 'Missing authorization header|Invalid JWT|JWT expired'; then
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

  # Only claim a verified surface when every action was both reachable and known.
  if [[ "$drift" -eq 0 && "$transport" -eq 0 ]]; then
    record_pass "ops-api action-surface: all ${total} required actions recognised"
  elif [[ "$transport" -gt 0 ]]; then
    echo "NOTE: ${transport} of ${total} actions were unreachable, so the action surface is UNVERIFIED, not proven broken." >&2
  fi
fi

if [[ -n "$SLOW_REPORT" ]]; then
  echo ""
  echo "== Slow responses (>= ${SLOW_SECONDS}s) =="
  printf '%s' "$SLOW_REPORT"
fi

echo "== Results: ${PASS} passed, ${FAIL} failed =="
exit "$FAIL"
