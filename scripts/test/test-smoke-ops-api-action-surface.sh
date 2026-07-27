#!/usr/bin/env bash
# Regression tests for the post-deploy ops-api action-surface smoke contract.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SMOKE_SCRIPT="$REPO_ROOT/scripts/smoke-ops-api-action-surface.sh"
MANIFEST="$REPO_ROOT/scripts/_ops-api-required-actions.txt"
SOURCE_CHECK="$REPO_ROOT/scripts/check-ops-api-source-actions.sh"
OPS_API_SOURCE="$REPO_ROOT/supabase/functions/ops-api/index.ts"

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
  printf '%s\n' '{"source_repo":"secureworks-site","build_label":"test","metadata_status":"bundled","commit_sha":"abcdef0123456789abcdef0123456789abcdef01","deployed_at":"2026-07-27T10:11:12Z"}'
  exit 0
fi

case ",${UNKNOWN_ACTIONS:-}," in
  *,"$action",*)
    printf '%s\n' '{"error":"Unknown action"}'
    exit 0
    ;;
esac

# Stands in for the real bound validation: runDeterministicIntake rejects a
# max_sources outside 1..2000 before it reads or commits a sweep cursor, so an
# unbounded replay probe is the only one that comes back with a report.
if [[ "$action" == "makesafe_deterministic_intake_replay" ]]; then
  if printf '%s' "$url" | grep -q 'max_sources=0'; then
    printf '%s\n' '{"error":"deterministic source read cap must be an integer between 1 and 2000"}'
  else
    printf '%s\n' '{"ok":true,"source_read":{"next_cursor_at":"2026-07-26T00:00:00Z"}}'
  fi
  exit 0
fi

case "$action" in
  trade_calendar | my_jobs | my_work_orders | submit_work_order_invoice | allocate_job | reattend_makesafe)
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

# Actions the smoke script is allowed to send at production, and the ones whose
# recognition is proved by the source gate alone. Both come from the manifest so
# a new entry is governed by its own declared policy, not by a list in here.
manifest_probed_actions() {
  grep -vE '^[[:space:]]*(#|$)' "$MANIFEST" |
    grep -v 'probe=source-only' |
    awk '{print $1}'
}

manifest_source_only_actions() {
  grep -vE '^[[:space:]]*(#|$)' "$MANIFEST" |
    grep 'probe=source-only' |
    awk '{print $1}'
}

manifest_actions_with_policy() {
  grep -vE '^[[:space:]]*(#|$)' "$MANIFEST" |
    grep "probe=$1" |
    awk '{print $1}'
}

manifest_policy_probed_actions() {
  grep -vE '^[[:space:]]*(#|$)' "$MANIFEST" |
    grep -E '#[[:space:]]*probe=' |
    grep -v 'probe=source-only' |
    awk '{print $1}'
}

# The dispatch block an action actually reaches: its own case label, any labels
# it falls through from, and the shared body up to the next case that follows
# real code. Only the FIRST label for a name is read, because a duplicate case
# later in the same switch is dead code.
action_dispatch_block() {
  awk -v action="$1" '
    BEGIN {
      caseRe = "^[[:space:]]*case \047[A-Za-z_]+\047:"
      target = "^[[:space:]]*case \047" action "\047:"
    }
    !started { if ($0 ~ target) { started = 1; startNr = NR } else next }
    {
      if ($0 ~ caseRe && sawBody) exit
      if (NR - startNr > 12) exit
      print
      line = $0
      sub(caseRe, "", line)
      if (line ~ /[^[:space:]]/) sawBody = 1
    }
  ' "$OPS_API_SOURCE"
}

# Manifest actions whose dispatch block guards on authTrade, so an API-key probe
# is refused at authentication instead of reaching a tenant read.
authtrade_gated_actions() {
  local action
  while IFS= read -r action; do
    [[ -z "$action" ]] && continue
    if action_dispatch_block "$action" | grep -q 'authTrade(req'; then
      printf '%s\n' "$action"
    fi
  done < <(manifest_actions)
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

requested_action() {
  local log="$1"
  local action="$2"
  local method="${3:-}"
  awk -F '\t' -v action="$action" -v method="$method" '
    (method == "" || $1 == method) && $2 ~ ("[?&]action=" action "(&|$)") { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$log"
}

# Any action carrying a probe policy is GET-only by contract: the POST fallback
# exists to coax recognition out of write handlers, which is exactly what a
# bounded or fail-closed probe must never do.
has_policy_post() {
  local log="$1"
  shift
  local action
  for action in "$@"; do
    if requested_action "$log" "$action" POST; then
      return 0
    fi
  done
  return 1
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

  manifest_probed_actions | sort -u > "$expected"
  awk -F '\t' '{print $2}' "$log" |
    sed -n 's/.*[?&]action=\([^&]*\).*/\1/p' |
    sort -u > "$actual"

  if ! diff -u "$expected" "$actual" > "$TEST_TMP/manifest.diff"; then
    fail "$name" "smoke did not cover every probeable manifest action: $(cat "$TEST_TMP/manifest.diff")"
    return
  fi

  # Actions that mutate business data on a bare call must never reach production
  # from a verifier, so the source-gated set has to be absent from the wire log.
  local source_only
  while IFS= read -r source_only; do
    [[ -z "$source_only" ]] && continue
    if requested_action "$log" "$source_only"; then
      fail "$name" "source-gated action was called against production: $source_only"
      return
    fi
  done < <(manifest_source_only_actions)

  if ! grep -Fq $'GET\thttps://example.invalid/functions/v1/ops-api?action=makesafe_deterministic_intake_replay&max_sources=0' "$log"; then
    fail "$name" "deterministic replay was not probed with the refused max_sources=0 bound"
    return
  fi

  # shellcheck disable=SC2046
  if has_policy_post "$log" $(manifest_policy_probed_actions); then
    fail "$name" "a bounded/JWT recognition action used POST"
    return
  fi

  if grep -Eq $'\ttrue$' "$log"; then
    fail "$name" "recognition sent an Authorization header instead of failing closed at authTrade"
    return
  fi

  for action in trade_calendar my_jobs my_work_orders submit_work_order_invoice; do
    if ! manifest_actions_with_policy jwt-fail-closed | grep -Fxq "$action"; then
      fail "$name" "Trade action missing a jwt-fail-closed probe policy in the manifest: $action"
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
    'makesafe_deterministic_intake_replay # probe=bounded-refusal probe-args=max_sources=0' \
    'trade_calendar # probe=jwt-fail-closed' \
    'my_jobs # probe=jwt-fail-closed' \
    'my_work_orders # probe=jwt-fail-closed' \
    'submit_work_order_invoice # probe=jwt-fail-closed' > "$manifest"

  if run_smoke "$manifest" "$log" "$output" \
    "makesafe_deterministic_intake_replay,trade_calendar,my_jobs,my_work_orders,submit_work_order_invoice"; then
    fail "$name" "smoke unexpectedly accepted unknown read-only actions"
    return
  fi

  if has_policy_post "$log" \
    makesafe_deterministic_intake_replay trade_calendar my_jobs my_work_orders submit_work_order_invoice; then
    fail "$name" "unknown read-only action fell back to POST"
    return
  fi

  if ! grep -Fq 'action=makesafe_deterministic_intake_replay&max_sources=0' "$log"; then
    fail "$name" "unknown replay probe lost its explicit bound"
    return
  fi

  pass "$name"
}

test_source_only_actions_are_never_sent_to_production() {
  local name="test_source_only_actions_are_never_sent_to_production"
  local manifest="$TEST_TMP/source-only-actions.txt"
  local log="$TEST_TMP/source-only.log"
  local output="$TEST_TMP/source-only.out"

  printf '%s\n' \
    'ops_api_version' \
    'makesafe_reporting_intake_pass # probe=source-only' \
    'makesafe_status_shadow_refresh # probe=source-only' > "$manifest"

  if ! run_smoke "$manifest" "$log" "$output"; then
    fail "$name" "smoke failed on a source-gated manifest: $(tail -n 5 "$output")"
    return
  fi

  local action
  for action in makesafe_reporting_intake_pass makesafe_status_shadow_refresh; do
    if requested_action "$log" "$action"; then
      fail "$name" "source-gated action reached production: $action"
      return
    fi
  done

  if ! grep -Fq 'source-gated' "$output"; then
    fail "$name" "smoke did not report which actions it skipped: $(tail -n 5 "$output")"
    return
  fi

  pass "$name"
}

test_jwt_policy_is_enforced_for_any_manifest_action() {
  local name="test_jwt_policy_is_enforced_for_any_manifest_action"
  local manifest="$TEST_TMP/jwt-policy.txt"
  local log="$TEST_TMP/jwt-policy.log"
  local output="$TEST_TMP/jwt-policy.out"

  # A Trade action the smoke script has never heard of. The fake surface answers
  # it with data rather than "Login required", which is exactly the tenant leak
  # the policy exists to catch.
  printf '%s\n' 'my_hours # probe=jwt-fail-closed' > "$manifest"

  if run_smoke "$manifest" "$log" "$output"; then
    fail "$name" "smoke passed a JWT action that answered an API-key caller with data"
    return
  fi

  if ! grep -Fq 'did not fail closed at authentication' "$output"; then
    fail "$name" "smoke failed for the wrong reason: $(tail -n 5 "$output")"
    return
  fi

  pass "$name"
}

test_bounded_probe_that_runs_instead_of_refusing_fails() {
  local name="test_bounded_probe_that_runs_instead_of_refusing_fails"
  local manifest="$TEST_TMP/bounded-policy.txt"
  local log="$TEST_TMP/bounded-policy.log"
  local output="$TEST_TMP/bounded-policy.out"

  # Same policy, bound dropped: the handler now runs a real sweep and returns a
  # report, so recognition must not be accepted.
  printf '%s\n' 'makesafe_deterministic_intake_replay # probe=bounded-refusal' > "$manifest"

  if run_smoke "$manifest" "$log" "$output"; then
    fail "$name" "smoke passed a replay probe that executed a sweep"
    return
  fi

  if ! grep -Fq 'ran instead of refusing probe bound' "$output"; then
    fail "$name" "smoke failed for the wrong reason: $(tail -n 5 "$output")"
    return
  fi

  pass "$name"
}

test_authtrade_gated_actions_declare_jwt_fail_closed() {
  local name="test_authtrade_gated_actions_declare_jwt_fail_closed"
  local gated="$TEST_TMP/authtrade-gated"
  local declared="$TEST_TMP/authtrade-declared"

  authtrade_gated_actions | sort -u > "$gated"

  if [[ ! -s "$gated" ]]; then
    fail "$name" "found no authTrade-gated manifest actions; the source scan has stopped matching"
    return
  fi

  manifest_actions_with_policy jwt-fail-closed | sort -u > "$declared"

  local action
  while IFS= read -r action; do
    [[ -z "$action" ]] && continue
    if ! grep -Fxq "$action" "$declared"; then
      fail "$name" "authTrade-gated action inherits the live policy instead of declaring probe=jwt-fail-closed: $action"
      return
    fi
  done < "$gated"

  # allocate_job and reattend_makesafe are the pair that reached production
  # unasserted; keep them named so a scan regression cannot quietly pass.
  for action in allocate_job reattend_makesafe; do
    if ! grep -Fxq "$action" "$gated"; then
      fail "$name" "source scan no longer recognises $action as authTrade-gated"
      return
    fi
  done

  pass "$name"
}

test_unknown_probe_policy_fails_closed() {
  local name="test_unknown_probe_policy_fails_closed"
  local manifest="$TEST_TMP/bad-policy.txt"
  local log="$TEST_TMP/bad-policy.log"
  local output="$TEST_TMP/bad-policy.out"

  printf '%s\n' 'my_jobs # probe=whatever' > "$manifest"

  if run_smoke "$manifest" "$log" "$output"; then
    fail "$name" "smoke accepted an undeclared probe policy"
    return
  fi

  if requested_action "$log" my_jobs; then
    fail "$name" "an action with an undeclared policy was still sent to production"
    return
  fi

  pass "$name"
}

main() {
  echo "Running ops-api action-surface smoke tests..."
  echo

  test_bounded_read_only_complete_manifest
  test_unknown_read_only_actions_never_fall_back_to_post
  test_source_only_actions_are_never_sent_to_production
  test_jwt_policy_is_enforced_for_any_manifest_action
  test_bounded_probe_that_runs_instead_of_refusing_fails
  test_authtrade_gated_actions_declare_jwt_fail_closed
  test_unknown_probe_policy_fails_closed

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
