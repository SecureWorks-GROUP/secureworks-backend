#!/usr/bin/env bash
# Fixture tests for the production migration auto-apply runner.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER="$REPO_ROOT/scripts/apply-pending-migrations.sh"
PASS_COUNT=0
FAIL_COUNT=0
TEST_TMP="$(mktemp -d 2>/dev/null || mktemp -d -t migration-autoapply-test)"

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
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

make_fake_curl() {
  local path="$1"
  python3 - "$path" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_text("""#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import re
import sys

args = sys.argv[1:]
output_path = Path(args[args.index("-o") + 1])
payload_path = Path(args[args.index("--data-binary") + 1][1:])
query = json.loads(payload_path.read_text())["query"]
state_path = Path(os.environ["FAKE_STATE"])
events_path = Path(os.environ["FAKE_EVENTS"])
state = json.loads(state_path.read_text()) if state_path.exists() else {"ledger": []}

def emit(code, body):
    output_path.write_text(json.dumps(body))
    print(code, end="")

if "ORDER BY version" in query:
    emit("200", state["ledger"])
elif "WHERE version =" in query and "INSERT INTO" not in query:
    match = re.search(r"WHERE version = '([0-9]{14})'", query)
    version = match.group(1)
    emit("200", [row for row in state["ledger"] if row["version"] == version])
elif "INSERT INTO supabase_migrations.schema_migrations" in query:
    events_path.write_text(events_path.read_text() + "ledger\\n")
    match = re.search(
        r"VALUES \\(\\s*'([0-9]{14})',\\s*'([a-z0-9_]+)',", query, re.S
    )
    version, name = match.groups()
    encoded = re.search(r"decode\\('([^']+)', 'base64'\\)", query).group(1)
    import base64
    sha = hashlib.sha256(base64.b64decode(encoded)).hexdigest()
    row = {
        "version": version,
        "name": name,
        "statement_count": 1,
        "raw_statement_sha256": sha,
    }
    if not any(existing["version"] == version for existing in state["ledger"]):
        state["ledger"].append(row)
        state_path.write_text(json.dumps(state))
    emit("200", [entry for entry in state["ledger"] if entry["version"] == version])
else:
    events_path.write_text(events_path.read_text() + "apply\\n")
    if os.environ.get("FAKE_FAIL_MIGRATION") == "1":
        emit("400", {"message": "fixture migration failed"})
    else:
        emit("200", [])
""")
Path(sys.argv[1]).chmod(0o755)
PY
}

run_fixture() {
  local migration_dir="$1"
  local exclusions="$2"
  shift 2
  local fake_curl="$TEST_TMP/fake-curl"
  local state="$TEST_TMP/state.json"
  local events="$TEST_TMP/events"
  make_fake_curl "$fake_curl"
  if [[ -n "${FIXTURE_LEDGER_JSON:-}" ]]; then
    printf '%s' "$FIXTURE_LEDGER_JSON" > "$state"
  else
    printf '%s' '{"ledger":[]}' > "$state"
  fi
  : > "$events"
  FAKE_STATE="$state" \
  FAKE_EVENTS="$events" \
  CURL_BIN="$fake_curl" \
  SUPABASE_ACCESS_TOKEN=test \
  SUPABASE_MIGRATION_DIR="$migration_dir" \
  MIGRATION_AUTOAPPLY_EXCLUSIONS_FILE="$exclusions" \
  MIGRATION_AUTOAPPLY_LEDGER_ALIASES_FILE="${FIXTURE_ALIASES_FILE:-$TEST_TMP/empty-aliases}" \
  MIGRATION_AUTOAPPLY_MIN_VERSION=00000000000000 \
    bash "$RUNNER" "$@"
}

test_dry_run_orders_pending_and_reports_exclusions() {
  local name="test_dry_run_orders_pending_and_reports_exclusions"
  local dir="$TEST_TMP/dry-run-migrations" exclusions="$TEST_TMP/dry-run-exclusions"
  local output rc first_line second_line
  mkdir -p "$dir"
  printf '%s\n' 'SELECT 2;' > "$dir/20260102000000_second.sql"
  printf '%s\n' 'SELECT 1;' > "$dir/20260101000000_first.sql"
  printf '%s\n' 'SELECT 3;' > "$dir/20260103000000_skip.sql"
  printf 'supabase/migrations/%s|%s|fixture_skip|fixture reviewed exclusion\n' \
    "20260103000000_skip.sql" \
    "$(sha256_file "$dir/20260103000000_skip.sql")" > "$exclusions"

  output="$(run_fixture "$dir" "$exclusions" --dry-run 2>&1)"
  rc=$?
  first_line="$(grep -n 'PENDING 1 20260101000000_first' <<<"$output" | cut -d: -f1)"
  second_line="$(grep -n 'PENDING 2 20260102000000_second' <<<"$output" | cut -d: -f1)"
  if [[ "$rc" -eq 0 ]] && [[ "$first_line" -lt "$second_line" ]] && \
    grep -q 'EXCLUDED 20260103000000_skip' <<<"$output" && \
    grep -q 'no production changes were made' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "dry-run fixture did not prove ordering/exclusion safety: rc=$rc output=$output"
  fi
}

test_apply_writes_ledger_only_after_success() {
  local name="test_apply_writes_ledger_only_after_success"
  local dir="$TEST_TMP/apply-migrations" exclusions="$TEST_TMP/apply-exclusions"
  local output rc events
  mkdir -p "$dir"
  printf '%s\n' 'SELECT 1;' > "$dir/20260101000000_first.sql"
  : > "$exclusions"
  output="$(run_fixture "$dir" "$exclusions" 2>&1)"
  rc=$?
  events="$(cat "$TEST_TMP/events")"
  if [[ "$rc" -eq 0 ]] && [[ "$events" == $'apply\nledger' ]] && \
    grep -q 'migration transaction committed successfully' <<<"$output" && \
    grep -q 'exact raw migration bytes recorded' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "successful fixture did not preserve apply -> verify -> ledger order: rc=$rc events=$events output=$output"
  fi
}

test_failed_migration_never_writes_ledger() {
  local name="test_failed_migration_never_writes_ledger"
  local dir="$TEST_TMP/fail-migrations" exclusions="$TEST_TMP/fail-exclusions"
  local output rc events
  mkdir -p "$dir"
  printf '%s\n' 'SELECT fixture_failure;' > "$dir/20260101000000_fail.sql"
  : > "$exclusions"
  output="$(
    FAKE_FAIL_MIGRATION=1 run_fixture "$dir" "$exclusions" 2>&1
  )"
  rc=$?
  events="$(cat "$TEST_TMP/events")"
  if [[ "$rc" -ne 0 ]] && [[ "$events" == "apply" ]] && \
    ! grep -q '^ledger$' "$TEST_TMP/events"; then
    pass "$name"
  else
    fail "$name" "failed migration was not loud or attempted a ledger write: rc=$rc events=$events output=$output"
  fi
}

test_unreviewed_collision_refuses() {
  local name="test_unreviewed_collision_refuses"
  local dir="$TEST_TMP/collision-migrations" exclusions="$TEST_TMP/collision-exclusions"
  local output rc
  mkdir -p "$dir"
  printf '%s\n' 'SELECT 1;' > "$dir/20260101000000_one.sql"
  printf '%s\n' 'SELECT 2;' > "$dir/20260101000000_two.sql"
  : > "$exclusions"
  output="$(run_fixture "$dir" "$exclusions" --dry-run 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]] && grep -q 'unledgered version collision' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "unreviewed collision did not fail closed: rc=$rc output=$output"
  fi
}

test_exclusion_hash_drift_refuses() {
  local name="test_exclusion_hash_drift_refuses"
  local dir="$TEST_TMP/hash-migrations" exclusions="$TEST_TMP/hash-exclusions"
  local output rc
  mkdir -p "$dir"
  printf '%s\n' 'SELECT 1;' > "$dir/20260101000000_skip.sql"
  printf '%s\n' \
    'supabase/migrations/20260101000000_skip.sql|0000000000000000000000000000000000000000000000000000000000000000|fixture_skip|fixture' \
    > "$exclusions"
  output="$(run_fixture "$dir" "$exclusions" --dry-run 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]] && grep -q 'exception hash drift' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "changed excluded file was still skipped: rc=$rc output=$output"
  fi
}

test_colliding_alias_and_exclusion_are_accounted_without_recording() {
  local name="test_colliding_alias_and_exclusion_are_accounted_without_recording"
  local dir="$TEST_TMP/alias-migrations"
  local exclusions="$TEST_TMP/alias-exclusions"
  local aliases="$TEST_TMP/alias-ledger"
  local output rc
  mkdir -p "$dir"
  printf '%s\n' 'SELECT 1;' > "$dir/20260101000000_applied_elsewhere.sql"
  printf '%s\n' 'SELECT 2;' > "$dir/20260101000000_excluded.sql"
  printf 'supabase/migrations/%s|%s|fixture_skip|fixture reviewed exclusion\n' \
    "20260101000000_excluded.sql" \
    "$(sha256_file "$dir/20260101000000_excluded.sql")" > "$exclusions"
  local ledger_sha
  ledger_sha="$(printf '%s\n' 'SELECT 1;' | shasum -a 256 | awk '{print $1}')"
  printf 'supabase/migrations/%s|%s|20260102000000|applied_elsewhere|%s|fixture historical alias\n' \
    "20260101000000_applied_elsewhere.sql" \
    "$(sha256_file "$dir/20260101000000_applied_elsewhere.sql")" \
    "$ledger_sha" > "$aliases"

  output="$(
    FIXTURE_ALIASES_FILE="$aliases" \
    FIXTURE_LEDGER_JSON='{"ledger":[{"version":"20260102000000","name":"applied_elsewhere","statement_count":1,"raw_statement_sha256":"'"$ledger_sha"'"}]}' \
      run_fixture "$dir" "$exclusions" --dry-run 2>&1
  )"
  rc=$?
  if [[ "$rc" -eq 0 ]] && \
    grep -q 'LEDGER_ALIAS 20260101000000_applied_elsewhere as=20260102000000_applied_elsewhere' <<<"$output" && \
    grep -q 'EXCLUDED 20260101000000_excluded' <<<"$output" && \
    grep -q 'pending_migrations: 0' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "reviewed alias/collision accounting failed: rc=$rc output=$output"
  fi
}

test_matching_ledger_name_requires_other_files_accounted() {
  local name="test_matching_ledger_name_requires_other_files_accounted"
  local dir="$TEST_TMP/matching-ledger-migrations" exclusions="$TEST_TMP/matching-ledger-exclusions"
  local output rc
  mkdir -p "$dir"
  printf '%s\n' 'SELECT applied;' > "$dir/20260101000000_applied.sql"
  printf '%s\n' 'SELECT collision;' > "$dir/20260101000000_collision.sql"
  printf 'supabase/migrations/%s|%s|fixture_collision|fixture reviewed collision\n' \
    "20260101000000_collision.sql" "$(sha256_file "$dir/20260101000000_collision.sql")" > "$exclusions"
  output="$(FIXTURE_LEDGER_JSON='{"ledger":[{"version":"20260101000000","name":"applied","statement_count":1,"raw_statement_sha256":"fixture"}]}' run_fixture "$dir" "$exclusions" --dry-run 2>&1)"
  rc=$?
  if [[ "$rc" -eq 0 ]] && grep -q 'ledgered_versions: 1' <<<"$output" && grep -q 'EXCLUDED 20260101000000_collision' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "matching ledger row did not require/account colliding files: rc=$rc output=$output"
  fi
}

test_mismatched_ledger_name_collision_refuses() {
  local name="test_mismatched_ledger_name_collision_refuses"
  local dir="$TEST_TMP/mismatched-ledger-migrations" exclusions="$TEST_TMP/mismatched-ledger-exclusions"
  local output rc
  mkdir -p "$dir"
  printf '%s\n' 'SELECT one;' > "$dir/20260101000000_one.sql"
  printf '%s\n' 'SELECT two;' > "$dir/20260101000000_two.sql"
  : > "$exclusions"
  output="$(FIXTURE_LEDGER_JSON='{"ledger":[{"version":"20260101000000","name":"elsewhere","statement_count":1,"raw_statement_sha256":"fixture"}]}' run_fixture "$dir" "$exclusions" --dry-run 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]] && grep -q 'ledger version/name collision' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "mismatched ledger name did not fail closed: rc=$rc output=$output"
  fi
}

test_ledger_alias_raw_checksum_mismatch_refuses() {
  local name="test_ledger_alias_raw_checksum_mismatch_refuses"
  local dir="$TEST_TMP/alias-checksum-migrations" exclusions="$TEST_TMP/alias-checksum-exclusions" aliases="$TEST_TMP/alias-checksum-ledger"
  local output rc
  mkdir -p "$dir"
  printf '%s\n' 'SELECT historical;' > "$dir/20260101000000_alias.sql"
  : > "$exclusions"
  printf 'supabase/migrations/%s|%s|20260102000000|historical|%s|fixture alias\n' \
    "20260101000000_alias.sql" "$(sha256_file "$dir/20260101000000_alias.sql")" \
    "$(printf '%s\n' 'SELECT expected;' | shasum -a 256 | awk '{print $1}')" > "$aliases"
  output="$(FIXTURE_ALIASES_FILE="$aliases" FIXTURE_LEDGER_JSON='{"ledger":[{"version":"20260102000000","name":"historical","statement_count":1,"raw_statement_sha256":"'"$(printf '%s\n' 'SELECT actual;' | shasum -a 256 | awk '{print $1}')"'"}]}' run_fixture "$dir" "$exclusions" --dry-run 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]] && grep -q 'ledger alias' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "ledger alias checksum drift did not fail closed: rc=$rc output=$output"
  fi
}

test_pending_transaction_control_refuses() {
  local name="test_pending_transaction_control_refuses"
  local dir="$TEST_TMP/transaction-migrations"
  local exclusions="$TEST_TMP/transaction-exclusions"
  local output rc
  mkdir -p "$dir"
  printf '%s\n' 'BEGIN;' 'SELECT 1;' 'ROLLBACK;' \
    > "$dir/20260101000000_transaction.sql"
  : > "$exclusions"
  output="$(run_fixture "$dir" "$exclusions" --dry-run 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]] && grep -q 'contains explicit transaction control' <<<"$output"; then
    pass "$name"
  else
    fail "$name" "transaction-controlling migration could be falsely ledgered: rc=$rc output=$output"
  fi
}

main() {
  echo "Running migration auto-apply fixture tests..."
  echo
  : > "$TEST_TMP/empty-aliases"
  test_dry_run_orders_pending_and_reports_exclusions
  test_apply_writes_ledger_only_after_success
  test_failed_migration_never_writes_ledger
  test_unreviewed_collision_refuses
  test_exclusion_hash_drift_refuses
  test_colliding_alias_and_exclusion_are_accounted_without_recording
  test_matching_ledger_name_requires_other_files_accounted
  test_mismatched_ledger_name_collision_refuses
  test_ledger_alias_raw_checksum_mismatch_refuses
  test_pending_transaction_control_refuses
  echo
  echo "Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  [[ "$FAIL_COUNT" -eq 0 ]] || exit 1
  echo "All tests passed."
}

main "$@"
