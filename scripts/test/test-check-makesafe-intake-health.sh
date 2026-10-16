#!/usr/bin/env bash
# Regression tests for the make-safe intake watchdog check
# (scripts/check-makesafe-intake-health.sh). A fake curl stands in for the
# Supabase Management API, so no test touches production.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-makesafe-intake-health.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/makesafe-intake-watchdog.yml"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()
TEST_TMP="$(mktemp -d 2>/dev/null || mktemp -d -t makesafe-intake-health-test)"

cleanup() {
  find "$TEST_TMP" -depth -delete
}
trap cleanup EXIT

pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "FAIL: $1" >&2
  echo "      $2" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_TESTS+=("$1")
}

# The fake writes FAKE_BODY to the -o file, records its argv and the posted
# payload, prints FAKE_HTTP_CODE for -w, and exits FAKE_EXIT (non-zero = a
# transport failure, like curl when the host cannot be reached).
FAKE_CURL="$TEST_TMP/fake-curl"
cat > "$FAKE_CURL" <<'SH'
#!/usr/bin/env bash
out=""
data=""
printf '%s\n' "$@" > "$FAKE_ARGS"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --data-binary) data="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "${data#@}" "$FAKE_PAYLOAD"
if [[ "${FAKE_EXIT:-0}" != "0" ]]; then
  exit "$FAKE_EXIT"
fi
printf '%s' "$FAKE_BODY" > "$out"
printf '%s' "$FAKE_HTTP_CODE"
SH
chmod +x "$FAKE_CURL"

OUTPUT=""
RC=0
run_check() {
  local body="$1" code="$2"
  OUTPUT="$(
    FAKE_BODY="$body" \
    FAKE_HTTP_CODE="$code" \
    FAKE_ARGS="$TEST_TMP/args" \
    FAKE_PAYLOAD="$TEST_TMP/payload.json" \
    CURL_BIN="$FAKE_CURL" \
    SUPABASE_ACCESS_TOKEN="${TOKEN-test-token}" \
    STALE_MINUTES="${STALE-30}" \
      bash "$CHECK" 2>&1
  )"
  RC=$?
}

expect() {
  local name="$1" want_rc="$2" needle="$3"
  if [[ "$RC" -ne "$want_rc" ]]; then
    fail "$name" "exit $RC, wanted $want_rc. Output: $OUTPUT"
  elif [[ "$OUTPUT" != *"$needle"* ]]; then
    fail "$name" "output lacks '$needle'. Output: $OUTPUT"
  else
    pass "$name"
  fi
}

run_check '[{"last_scan_at":"2026-10-16 04:51:04+00","extraction_status":"ok","scan_age_minutes":2}]' 200
expect "fresh scan passes" 0 "OK: make-safe intake pipeline healthy (scan 2 min ago, status=ok)"

if python3 - "$TEST_TMP/payload.json" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1]))
assert payload["read_only"] is True, payload
query = payload["query"]
assert query.lstrip().upper().startswith("SELECT "), query
assert "public.makesafe_intake_health" in query, query
for word in ("INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "CREATE", ";"):
    assert word not in query.upper(), word
PY
then pass "the read is one SELECT sent with read_only true"
else fail "the read is one SELECT sent with read_only true" "payload: $(cat "$TEST_TMP/payload.json")"
fi

if grep -qx "https://api.supabase.com/v1/projects/kevgrhcjxspbxgovpmfl/database/query" "$TEST_TMP/args" &&
   grep -qx "Authorization: Bearer test-token" "$TEST_TMP/args"; then
  pass "the read goes to the production Management API query endpoint with the token"
else
  fail "the read goes to the production Management API query endpoint with the token" "args: $(cat "$TEST_TMP/args")"
fi

if [[ "$OUTPUT" != *"test-token"* ]]; then
  pass "the token is never printed"
else
  fail "the token is never printed" "$OUTPUT"
fi

run_check '[{"last_scan_at":"2026-10-16 04:00:00+00","extraction_status":"ok","scan_age_minutes":30}]' 200
expect "a scan exactly at the budget passes" 0 "scan 30 min ago"

run_check '[{"last_scan_at":"2026-10-16 03:00:00+00","extraction_status":"ok","scan_age_minutes":31}]' 200
expect "a stale scan fails" 1 "make-safe intake scan is STALE (31 min > 30 min)"

STALE=60 run_check '[{"last_scan_at":"2026-10-16 03:00:00+00","extraction_status":"ok","scan_age_minutes":45}]' 200
expect "STALE_MINUTES sets the budget" 0 "budget 60 min"

run_check '[{"last_scan_at":null,"extraction_status":null,"scan_age_minutes":null}]' 200
expect "no last_scan_at fails" 1 "has no last_scan_at"

run_check '[]' 200
expect "a missing health row fails" 1 "expected exactly one makesafe_intake_health row, got 0"

run_check '{"message":"project is paused"}' 400
expect "a refused or paused-project read fails with its HTTP code" 1 "returned HTTP 400"

run_check '{"message":"Unauthorized"}' 401
expect "a refused token fails" 1 "returned HTTP 401"

run_check 'not json' 200
expect "a non-JSON answer fails" 1 "did not return JSON"

FAKE_EXIT=7 run_check '' ''
expect "an unreachable Management API fails" 1 "could not be reached"

TOKEN='' run_check '[]' 200
expect "a missing token fails before any request" 1 "SUPABASE_ACCESS_TOKEN is not set"

STALE=abc run_check '[]' 200
expect "a bad STALE_MINUTES fails" 1 "STALE_MINUTES must be a positive whole number"

# The workflow must run this check with the production environment token and
# must not send the shared SW_API_KEY anywhere (ops-api refuses it since #667).
# The workflow is parsed, so comments and other jobs cannot satisfy the check.
if WORKFLOW_RESULT="$(python3 - "$WORKFLOW" 2>&1 <<'PY'
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is not installed, so the workflow cannot be parsed")

workflow = yaml.safe_load(open(sys.argv[1]))
job = workflow["jobs"]["intake-health"]
environment = job.get("environment")
if isinstance(environment, dict):
    environment = environment.get("name")
assert environment == "production", f"intake-health environment is {environment!r}"

check_steps = [
    step for step in job.get("steps", [])
    if any(
        line.strip() == "bash scripts/check-makesafe-intake-health.sh"
        for line in str(step.get("run", "")).splitlines()
    )
]
assert len(check_steps) == 1, f"{len(check_steps)} steps run the check script"
token = (check_steps[0].get("env") or {}).get("SUPABASE_ACCESS_TOKEN")
assert token == "${{ secrets.SUPABASE_ACCESS_TOKEN }}", f"check step token is {token!r}"

def values(node):
    if isinstance(node, dict):
        for key, value in node.items():
            yield str(key)
            yield from values(value)
    elif isinstance(node, list):
        for value in node:
            yield from values(value)
    else:
        yield str(node)

leaks = [v for v in values(workflow) if "secrets.SW_API_KEY" in v.replace(" ", "")]
assert not leaks, f"SW_API_KEY is used: {leaks}"
PY
)"; then
  pass "the watchdog workflow runs this check with the production token and no SW_API_KEY"
else
  fail "the watchdog workflow runs this check with the production token and no SW_API_KEY" "$WORKFLOW_RESULT"
fi

echo ""
echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  printf '  - %s\n' "${FAILED_TESTS[@]}" >&2
  exit 1
fi
