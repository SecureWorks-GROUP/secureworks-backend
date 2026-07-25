#!/usr/bin/env bash
# Regression tests for the post-deploy ops-api action-surface smoke contract.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SMOKE_SCRIPT="$REPO_ROOT/scripts/smoke-ops-api-action-surface.sh"
MANIFEST="$REPO_ROOT/scripts/_ops-api-required-actions.txt"
SOURCE_CHECK="$REPO_ROOT/scripts/check-ops-api-source-actions.sh"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()
TEST_TMP="$(mktemp -d 2>/dev/null || mktemp -d -t ops-api-smoke-test)"

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

cat > "$TEST_TMP/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -u

method=GET
url=
authorization_header=false

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -X)
      shift
      method="${1:-}"
      ;;
    -H)
      shift
      case "${1:-}" in
        Authorization:*) authorization_header=true ;;
      esac
      ;;
    -d | --max-time)
      shift
      ;;
    http://* | https://*)
      url="$1"
      ;;
  esac
  shift
done

action="$(printf '%s' "$url" | sed -n 's/.*[?&]action=\([^&]*\).*/\1/p')"
printf '%s\t%s\t%s\n' "$method" "$url" "$authorization_header" >> "${CURL_LOG:?}"

if [[ "$action" == "ops_api_version" ]]; then
  printf '%s\n' '{"source_repo":"secureworks-site","build_label":"test"}'
  exit 0
fi

case ",${UNKNOWN_ACTIONS:-}," in
  *,"$action",*)
    printf '%s\n' '{"error":"Unknown action"}'
    exit 0
    ;;
esac

case "$action" in
  trade_calendar | my_jobs | my_work_orders | submit_work_order_invoice)
    printf '%s\n' '{"error":"Login required"}'
    ;;
  *)
    printf '%s\n' '{"ok":true}'
    ;;
esac
FAKE_CURL
chmod +x "$TEST_TMP/curl"

manifest_actions() {
  grep -vE '^[[:space:]]*(#|$)' "$MANIFEST" | awk '{print $1}'
}

run_smoke() {
  local manifest="$1"
  local log="$2"
  local output="$3"
  local unknown_actions="${4:-}"
  : > "$log"
  CURL_BIN="$TEST_TMP/curl" \
    CURL_LOG="$log" \
    UNKNOWN_ACTIONS="$unknown_actions" \
    SW_API_KEY=test-only \
    SUPABASE_FUNCTIONS_BASE=https://example.invalid/functions/v1 \
    REQUIRED_ACTIONS_FILE="$manifest" \
    bash "$SMOKE_SCRIPT" > "$output" 2>&1
}

has_read_only_post() {
  local log="$1"
  awk -F '\t' '
    $1 == "POST" &&
      $2 ~ /[?&]action=(makesafe_deterministic_intake_replay|trade_calendar|my_jobs|my_work_orders|submit_work_order_invoice)(&|$)/ {
      found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$log"
}

test_bounded_read_only_complete_manifest() {
  local name="test_bounded_read_only_complete_manifest"
  local log="$TEST_TMP/full.log"
  local output="$TEST_TMP/full.out"
  local expected="$TEST_TMP/expected-actions"
  local actual="$TEST_TMP/actual-actions"

  if ! run_smoke "$MANIFEST" "$log" "$output"; then
    fail "$name" "smoke failed against recognised fake surface: $(tail -n 5 "$output")"
    return
  fi

  manifest_actions | sort -u > "$expected"
  awk -F '\t' '{print $2}' "$log" |
    sed -n 's/.*[?&]action=\([^&]*\).*/\1/p' |
    sort -u > "$actual"

  if ! diff -u "$expected" "$actual" > "$TEST_TMP/manifest.diff"; then
    fail "$name" "smoke did not cover the complete manifest: $(cat "$TEST_TMP/manifest.diff")"
    return
  fi

  if ! grep -Fq $'GET\thttps://example.invalid/functions/v1/ops-api?action=makesafe_deterministic_intake_replay&days=1&max_sources=1' "$log"; then
    fail "$name" "deterministic replay was not requested with days=1 and max_sources=1"
    return
  fi

  if has_read_only_post "$log"; then
    fail "$name" "a bounded/JWT recognition action used POST"
    return
  fi

  if grep -Eq $'\ttrue$' "$log"; then
    fail "$name" "recognition sent an Authorization header instead of failing closed at authTrade"
    return
  fi

  for action in trade_calendar my_jobs my_work_orders submit_work_order_invoice; do
    if ! grep -Fxq "$action" "$expected"; then
      fail "$name" "required Trade action missing from manifest: $action"
      return
    fi
  done

  if ! (
    cd "$REPO_ROOT" &&
      bash "$SOURCE_CHECK" > "$TEST_TMP/source-check.out" 2>&1
  ); then
    fail "$name" "manifest contains an action absent from the ops-api source: $(tail -n 5 "$TEST_TMP/source-check.out")"
    return
  fi

  pass "$name"
}

test_unknown_read_only_actions_never_fall_back_to_post() {
  local name="test_unknown_read_only_actions_never_fall_back_to_post"
  local manifest="$TEST_TMP/read-only-actions.txt"
  local log="$TEST_TMP/unknown.log"
  local output="$TEST_TMP/unknown.out"

  printf '%s\n' \
    makesafe_deterministic_intake_replay \
    trade_calendar \
    my_jobs \
    my_work_orders \
    submit_work_order_invoice > "$manifest"

  if run_smoke "$manifest" "$log" "$output" \
    "makesafe_deterministic_intake_replay,trade_calendar,my_jobs,my_work_orders,submit_work_order_invoice"; then
    fail "$name" "smoke unexpectedly accepted unknown read-only actions"
    return
  fi

  if has_read_only_post "$log"; then
    fail "$name" "unknown read-only action fell back to POST"
    return
  fi

  if ! grep -Fq 'action=makesafe_deterministic_intake_replay&days=1&max_sources=1' "$log"; then
    fail "$name" "unknown replay probe lost its explicit bound"
    return
  fi

  pass "$name"
}

main() {
  echo "Running ops-api action-surface smoke tests..."
  echo

  test_bounded_read_only_complete_manifest
  test_unknown_read_only_actions_never_fall_back_to_post

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
