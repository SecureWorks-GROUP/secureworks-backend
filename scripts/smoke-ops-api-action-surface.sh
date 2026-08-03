#!/usr/bin/env bash
# Read-only ops-api action-surface smoke check for GitHub Actions.
#
# This intentionally does not use the Supabase CLI. It proves the deployed
# function recognises the required action names using the normal dashboard API
# key. How each action is proved is declared per line in
# scripts/_ops-api-required-actions.txt — see the probe policy table in its
# header. An unannotated action must not answer "Unknown action"; a probed
# action must refuse in its declared way; an action that a bare call would
# mutate is proved by the pre-deploy source gate and never called here.

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

# Probe policy is declared per action in the manifest, never in a list here. A
# second copy of the action names in this script would drift the moment someone
# adds a Trade action or a new sweep-triggering handler to the manifest, and the
# drift would look like a pass.
manifest_action() {
  printf '%s' "$1" | awk '{print $1}'
}

manifest_probe_policy() {
  local policy
  policy="$(printf '%s' "$1" | sed -n 's/.*#[[:space:]]*probe=\([A-Za-z-]*\).*/\1/p')"
  printf '%s' "${policy:-live}"
}

manifest_probe_args() {
  printf '%s' "$1" | sed -n 's/.*probe-args=\([^[:space:]]*\).*/\1/p'
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

# A deploy does not propagate to every isolate at once: for tens of seconds to
# minutes after `supabase functions deploy`, the version endpoint can still
# answer from a pre-deploy isolate, and every probe below would then grade the
# OLD revision. (2026-08-03: the lane failed 12 checks on the previous build's
# missing metadata and pre-fix auth behaviour ~30s after a good deploy, twice.)
# When the lane tells us what it just deployed, wait for that exact revision to
# answer twice in a row before grading anything. Outside the deploy lane (no
# expectation set) probe once, as before.
ops_version=""
if [[ -n "${EXPECTED_COMMIT_SHA:-}" ]]; then
  CONVERGE_TIMEOUT_SECONDS="${CONVERGE_TIMEOUT_SECONDS:-420}"
  CONVERGE_INTERVAL_SECONDS="${CONVERGE_INTERVAL_SECONDS:-15}"
  deadline=$(( $(date +%s) + CONVERGE_TIMEOUT_SECONDS ))
  converged=0
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    ops_version="$(json_get "${BASE}/ops-api?action=ops_api_version")"
    if printf '%s' "$ops_version" | grep -q "\"commit_sha\":\"${EXPECTED_COMMIT_SHA}\""; then
      converged=$((converged + 1))
      if (( converged >= 2 )); then
        echo "Deployed revision ${EXPECTED_COMMIT_SHA} answering on ${converged} consecutive probes (attempt ${attempt}); grading that revision."
        break
      fi
      echo "Deployed revision seen once; confirming convergence..."
    else
      converged=0
      echo "Waiting for deployed revision ${EXPECTED_COMMIT_SHA} to propagate (attempt ${attempt})..."
    fi
    if (( $(date +%s) >= deadline )); then
      record_fail "ops-api never converged to deployed revision ${EXPECTED_COMMIT_SHA} within ${CONVERGE_TIMEOUT_SECONDS}s (last answer: $(printf '%s' "$ops_version" | head -c 200))"
      echo "== Results: ${PASS} passed, ${FAIL} failed =="
      exit "$FAIL"
    fi
    sleep "${CONVERGE_INTERVAL_SECONDS}"
  done
else
  ops_version="$(json_get "${BASE}/ops-api?action=ops_api_version")"
fi
assert_not_unknown "ops-api ops_api_version recognised" "$ops_version"
assert_contains "ops-api canonical source" "$ops_version" '"source_repo":"secureworks-site"'
assert_contains "ops-api version includes build label" "$ops_version" '"build_label":'
assert_contains "ops-api version uses bundled metadata" "$ops_version" '"metadata_status":"bundled"'

if [[ -n "${EXPECTED_COMMIT_SHA:-}" ]]; then
  assert_contains "ops-api commit_sha matches deployed source" \
    "$ops_version" "\"commit_sha\":\"${EXPECTED_COMMIT_SHA}\""
fi
if [[ -n "${EXPECTED_DEPLOYED_AT:-}" ]]; then
  assert_contains "ops-api deployed_at matches deployment" \
    "$ops_version" "\"deployed_at\":\"${EXPECTED_DEPLOYED_AT}\""
fi

if [[ ! -f "$REQUIRED_ACTIONS_FILE" ]]; then
  record_fail "required action manifest missing: ${REQUIRED_ACTIONS_FILE}"
else
  drift=0
  total=0
  source_gated=0
  while IFS= read -r manifest_line; do
    action="$(manifest_action "$manifest_line")"
    [[ -z "$action" ]] && continue
    policy="$(manifest_probe_policy "$manifest_line")"
    probe_args="$(manifest_probe_args "$manifest_line")"
    total=$((total + 1))

    case "$policy" in
      live | jwt-fail-closed | bounded-refusal | source-only) ;;
      *)
        record_fail "ops-api manifest: action '${action}' declares unknown probe policy '${policy}'"
        drift=$((drift + 1))
        continue
        ;;
    esac

    # A bound with no policy behind it is a typo, and the fallback would be the
    # unbounded live probe the bound was written to prevent.
    if [[ "$policy" == "live" && -n "$probe_args" ]]; then
      record_fail "ops-api manifest: action '${action}' declares probe-args without a probe policy"
      drift=$((drift + 1))
      continue
    fi

    if [[ "$policy" == "source-only" ]]; then
      # Calling these with the master key mutates business data on a bare
      # request, so verification stays on the pre-deploy source gate rather
      # than buying drift detection with a production write.
      source_gated=$((source_gated + 1))
      record_pass "ops-api action '${action}' source-gated (deliberately not probed against production)"
      continue
    fi

    probe_url="${BASE}/ops-api?action=${action}"
    if [[ -n "$probe_args" ]]; then
      probe_url="${probe_url}&${probe_args}"
    fi
    body="$(json_get "$probe_url")"

    if printf '%s' "$body" | grep -Eqi 'Missing authorization header|Invalid JWT|JWT expired'; then
      record_fail "ops-api drift: action '${action}' blocked by gateway/JWT"
      drift=$((drift + 1))
      continue
    fi

    if printf '%s' "$body" | grep -qi 'Unknown action'; then
      if [[ "$policy" != "live" ]]; then
        record_fail "ops-api drift: read-only probe for action '${action}' returns Unknown action"
        drift=$((drift + 1))
        continue
      fi
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
      continue
    fi

    case "$policy" in
      jwt-fail-closed)
        if printf '%s' "$body" | grep -Eqi '"error"[[:space:]]*:[[:space:]]*"Login required"'; then
          record_pass "ops-api action '${action}' recognised and refused at authTrade"
        else
          record_fail "ops-api drift: JWT action '${action}' did not fail closed at authentication"
          drift=$((drift + 1))
        fi
        ;;
      bounded-refusal)
        if printf '%s' "$body" | grep -q '"error"'; then
          record_pass "ops-api action '${action}' recognised and refused its invalid probe bound"
        else
          record_fail "ops-api drift: action '${action}' ran instead of refusing probe bound '${probe_args}'"
          drift=$((drift + 1))
        fi
        ;;
      *)
        record_pass "ops-api action '${action}' recognised"
        ;;
    esac
  done < <(grep -vE '^[[:space:]]*(#|$)' "$REQUIRED_ACTIONS_FILE")

  if [[ "$drift" -eq 0 ]]; then
    record_pass "ops-api action-surface: all ${total} required actions recognised (${source_gated} source-gated, not probed against production)"
  fi
fi

echo "== Results: ${PASS} passed, ${FAIL} failed =="
exit "$FAIL"
