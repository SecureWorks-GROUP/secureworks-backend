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

# S6 drift detection — commit_sha assertion.
#
# The deploy script stamps COMMIT_SHA into the edge function's runtime env
# (via supabase secrets set) before deploy. opsApiVersion() reads it from
# Deno.env and returns it in the response. If EXPECTED_COMMIT_SHA is set by
# the caller (deploy-edge-function.sh exports it before invoking smoke), we
# assert the deployed binary's commit matches the canonical worktree HEAD.
# When unset (manual smoke runs, CI without git context), we warn-skip
# rather than fail so the check isn't false-alarm noise.
if [[ -n "${EXPECTED_COMMIT_SHA:-}" ]]; then
  if printf '%s' "$ops_version" | grep -q "\"commit_sha\":\"${EXPECTED_COMMIT_SHA}\""; then
    record_pass "ops-api commit_sha matches expected ${EXPECTED_COMMIT_SHA:0:8}"
  else
    actual_block="$(printf '%s' "$ops_version" | grep -oE '"commit_sha":[^,}]*' || echo '"commit_sha":<missing>')"
    record_fail "ops-api commit_sha mismatch: deployed has ${actual_block}, expected ${EXPECTED_COMMIT_SHA:0:8}"
  fi
else
  echo "[warn] EXPECTED_COMMIT_SHA not set; skipping commit_sha drift assertion"
fi

# S6 drift detection — full action-surface iteration.
#
# Reads scripts/_ops-api-required-actions.txt (single source of truth shared
# with deploy-edge-function.sh's source-side require_ops_actions check). For
# every required action, fires a no-op request and asserts no "Unknown
# action" in the response. Detects stale-binary drift where the deployed
# function is missing a handler that exists in source.
REQUIRED_ACTIONS_FILE="${REQUIRED_ACTIONS_FILE:-scripts/_ops-api-required-actions.txt}"
if [[ -f "$REQUIRED_ACTIONS_FILE" ]]; then
  drift=0
  total=0
  while IFS= read -r action; do
    [[ -z "$action" ]] && continue
    total=$((total + 1))
    body="$(json_get "${BASE}/ops-api?action=${action}")"
    if printf '%s' "$body" | grep -qi 'Unknown action'; then
      # Try POST as some action handlers gate on method.
      body="$(json_post "${BASE}/ops-api?action=${action}" '{}')"
      if printf '%s' "$body" | grep -qi 'Unknown action'; then
        record_fail "ops-api drift: action '${action}' returns Unknown action"
        drift=$((drift + 1))
      fi
    fi
  done < <(grep -vE '^\s*(#|$)' "$REQUIRED_ACTIONS_FILE" | awk '{print $1}')
  if [[ "$drift" -eq 0 ]]; then
    record_pass "ops-api action-surface: all ${total} required actions recognised"
  fi
else
  echo "[warn] required-actions manifest missing at $REQUIRED_ACTIONS_FILE; skipping action-surface drift check"
fi

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
