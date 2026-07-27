#!/usr/bin/env bash
# Regression tests for the read-only production Edge Function schema gate.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREFLIGHT="$REPO_ROOT/scripts/check-edge-schema-preflight.sh"
MANIFEST="$REPO_ROOT/scripts/edge-function-schema-requirements.txt"
MIGRATION="$REPO_ROOT/supabase/migrations/20260727000001_makesafe_attendance_cycles_u2_s1.sql"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()
TEST_TMP="$(mktemp -d 2>/dev/null || mktemp -d -t edge-schema-preflight-test)"

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

migration_sha() {
  shasum -a 256 "$MIGRATION" | awk '{print $1}'
}

ledger_statement_sha() {
  python3 - <<'PY'
import hashlib
import json

statements = [
    "CREATE TABLE public.makesafe_attendance_cycles (id uuid PRIMARY KEY);",
    "ALTER TABLE public.job_service_reports ADD COLUMN attendance_cycle_id uuid;",
]
print(hashlib.sha256(json.dumps(statements, separators=(",", ":")).encode()).hexdigest())
PY
}

write_response() {
  local file="$1"
  local actual_name="$2"
  local actual_sha="$3"
  local missing_markers_json="$4"
  EXPECTED_SHA="$(migration_sha)" \
  ACTUAL_NAME="$actual_name" \
  ACTUAL_SHA="$actual_sha" \
  MISSING_MARKERS_JSON="$missing_markers_json" \
  python3 - "$file" <<'PY'
import json
import os
import sys

actual_name = os.environ["ACTUAL_NAME"] or None
actual_sha = os.environ["ACTUAL_SHA"] or None
row = {
    "function_name": "ops-api",
    "migration_version": "20260727000001",
    "expected_migration_name": "makesafe_attendance_cycles_u2_s1",
    "expected_statement_sha256": os.environ["EXPECTED_SHA"],
    "actual_migration_name": actual_name,
    "actual_statement_count": 2 if actual_name else None,
    "actual_statement_sha256": actual_sha,
    "missing_markers": json.loads(os.environ["MISSING_MARKERS_JSON"]),
}
with open(sys.argv[1], "w") as f:
    json.dump([row], f)
PY
}

run_preflight() {
  local response_file="$1"
  shift
  local output_file="$TEST_TMP/output"
  EDGE_SCHEMA_PREFLIGHT_TEST_MODE=1 \
  SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE="$response_file" \
  bash "$PREFLIGHT" "$@" >"$output_file" 2>&1
  PREFLIGHT_RC=$?
  PREFLIGHT_OUTPUT="$(cat "$output_file")"
}

test_incident_dependency_is_declared() {
  local name="test_incident_dependency_is_declared"
  local expected='ops-api|supabase/migrations/20260727000001_makesafe_attendance_cycles_u2_s1.sql|column|job_service_reports.attendance_cycle_id'
  if grep -Fxq "$expected" "$MANIFEST"; then
    pass "$name"
  else
    fail "$name" "the exact column that broke Hugo's Board is not a permanent ops-api deploy requirement"
  fi
}

# Exact incident sequence: source that requires U2-S1 reaches the deploy gate,
# but the production migration ledger/schema is missing. Deployment must stop.
test_missing_migration_refuses_before_deploy() {
  local name="test_missing_migration_refuses_before_deploy"
  local response="$TEST_TMP/missing.json"
  write_response "$response" "" "" '["column:job_service_reports.attendance_cycle_id"]'
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -ne 0 ]] && \
    grep -q 'migration ledger row is missing' <<<"$PREFLIGHT_OUTPUT" && \
    grep -q 'Refusing Edge Function deploy' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "missing migration did not stop deployment: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_multi_statement_ledger_may_deploy() {
  local name="test_multi_statement_ledger_may_deploy"
  local response="$TEST_TMP/applied.json"
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "$(ledger_statement_sha)" '[]'
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -eq 0 ]] && \
    grep -q 'PASS edge schema preflight' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "fully applied schema was refused: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_missing_schema_marker_refuses() {
  local name="test_missing_schema_marker_refuses"
  local response="$TEST_TMP/missing-marker.json"
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "$(ledger_statement_sha)" '["table:makesafe_report_pack_cycles"]'
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -ne 0 ]] && \
    grep -q 'required production markers missing' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "missing schema marker did not stop deployment: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_statement_checksum_drift_is_advisory() {
  local name="test_statement_checksum_drift_is_advisory"
  local response="$TEST_TMP/checksum.json"
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "0000000000000000000000000000000000000000000000000000000000000000" '[]'
  run_preflight "$response" ops-api
  if [[ "$PREFLIGHT_RC" -eq 0 ]] && \
    grep -q 'ledger statement-set checksum differs' <<<"$PREFLIGHT_OUTPUT"; then
    pass "$name"
  else
    fail "$name" "checksum drift was not advisory: rc=$PREFLIGHT_RC output=$PREFLIGHT_OUTPUT"
  fi
}

test_unrelated_function_without_requirements_passes_without_credentials() {
  local name="test_unrelated_function_without_requirements_passes_without_credentials"
  local output rc
  output="$(env -u SUPABASE_ACCESS_TOKEN -u SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE \
    bash "$PREFLIGHT" send-quote 2>&1)"
  rc=$?
  if [[ "$rc" -eq 0 ]] && grep -q 'no declared requirements' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "unrelated function required production credentials: rc=$rc output=$output"
  fi
}

test_fixture_response_requires_explicit_test_mode() {
  local name="test_fixture_response_requires_explicit_test_mode"
  local response="$TEST_TMP/guarded-fixture.json" output rc
  write_response "$response" "makesafe_attendance_cycles_u2_s1" "$(migration_sha)" '[]'
  output="$(SUPABASE_SCHEMA_PREFLIGHT_RESPONSE_FILE="$response" \
    bash "$PREFLIGHT" ops-api 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]] && grep -q 'only in explicit test mode' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "fixture seam was usable outside test mode: rc=$rc output=$output"
  fi
}

main() {
  echo "Running Edge Function schema preflight tests..."
  echo
  if [[ ! -f "$PREFLIGHT" || ! -f "$MANIFEST" || ! -f "$MIGRATION" ]]; then
    fail "test_setup" "preflight, manifest, or canonical migration missing"
  else
    test_incident_dependency_is_declared
    test_missing_migration_refuses_before_deploy
    test_multi_statement_ledger_may_deploy
    test_missing_schema_marker_refuses
    test_statement_checksum_drift_is_advisory
    test_unrelated_function_without_requirements_passes_without_credentials
    test_fixture_response_requires_explicit_test_mode
  fi

  echo
  echo "Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo "Failed tests:" >&2
    printf '  %s\n' "${FAILED_TESTS[@]}" >&2
    exit 1
  fi
  echo "All tests passed."
}

main "$@"
