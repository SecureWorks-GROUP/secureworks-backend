#!/bin/bash
# Shell tests for scripts/deploy-edge.sh
#
# Written red-first to ensure the guard script genuinely enforces:
#   - bare invocation refuses
#   - override + dirty tree refuses
#   - override + non-main branch refuses
#   - override + clean main proceeds (without invoking supabase)
#   - override path logs OVERRIDE banner with git ref to stderr
#   - variable-form invocation is still caught
#
# Most tests run in disposable temp git repos so the suite never mutates the
# real worktree state. The two tests that rely on the real repo (bare /
# variable-form refusal) only need ALLOW_MANUAL_DEPLOY_OVERRIDE to be unset.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GUARD_SCRIPT="$REPO_ROOT/scripts/deploy-edge.sh"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()

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

require_script() {
  if [[ ! -f "$GUARD_SCRIPT" ]]; then
    echo "FAIL (setup): guard script not found at $GUARD_SCRIPT" >&2
    exit 1
  fi
  if [[ ! -x "$GUARD_SCRIPT" ]]; then
    echo "FAIL (setup): guard script not executable at $GUARD_SCRIPT" >&2
    exit 1
  fi
}

mk_temp_repo() {
  # Args: $1 = branch name to start on (default main), $2 = "dirty" to leave an untracked file
  local branch="${1:-main}"
  local dirty="${2:-}"
  local dir
  dir="$(mktemp -d 2>/dev/null || mktemp -d -t deploy-edge-test)"
  (
    cd "$dir" || exit 1
    git init -q -b "$branch" >/dev/null 2>&1 || { git init -q >/dev/null; git checkout -q -b "$branch"; }
    git config user.email test@example.com
    git config user.name test
    echo init > file.txt
    git add file.txt
    git commit -q -m init
    if [[ "$dirty" == "dirty" ]]; then
      echo untracked > dirty.txt
    fi
  )
  echo "$dir"
}

run_guard() {
  # Args: $1 = working dir, $2 = env prefix (eg "ALLOW_MANUAL_DEPLOY_OVERRIDE=1"), $3 = function name
  local dir="$1"
  local env_prefix="$2"
  local fn="$3"
  local stdout stderr rc combined
  local out_file err_file
  out_file="$(mktemp)"
  err_file="$(mktemp)"
  (
    cd "$dir" || exit 99
    if [[ -n "$env_prefix" ]]; then
      env $env_prefix bash "$GUARD_SCRIPT" "$fn" >"$out_file" 2>"$err_file"
    else
      bash "$GUARD_SCRIPT" "$fn" >"$out_file" 2>"$err_file"
    fi
  )
  rc=$?
  GUARD_STDOUT="$(cat "$out_file")"
  GUARD_STDERR="$(cat "$err_file")"
  GUARD_RC=$rc
  rm -f "$out_file" "$err_file"
}

# Test 1: Bare invocation refuses (no override env var)
test_bare_refusal() {
  local name="test_bare_refusal"
  run_guard "$REPO_ROOT" "" "ops-api"
  if [[ $GUARD_RC -ne 0 ]] && echo "$GUARD_STDERR$GUARD_STDOUT" | grep -qiE 'BLOCKED|refused|manual deploy'; then
    pass "$name"
  else
    fail "$name" "expected nonzero exit and refusal message; rc=$GUARD_RC stderr=$GUARD_STDERR stdout=$GUARD_STDOUT"
  fi
}

# Test 2: Override + dirty tree refuses
test_override_dirty_tree() {
  local name="test_override_dirty_tree"
  local dir
  dir="$(mk_temp_repo main dirty)"
  run_guard "$dir" "ALLOW_MANUAL_DEPLOY_OVERRIDE=1" "ops-api"
  rm -rf "$dir"
  if [[ $GUARD_RC -ne 0 ]] && echo "$GUARD_STDERR$GUARD_STDOUT" | grep -qi 'dirty'; then
    pass "$name"
  else
    fail "$name" "expected nonzero exit and 'dirty' message; rc=$GUARD_RC stderr=$GUARD_STDERR"
  fi
}

# Test 3: Override + non-main branch refuses
test_override_non_main() {
  local name="test_override_non_main"
  local dir
  dir="$(mk_temp_repo feature)"
  run_guard "$dir" "ALLOW_MANUAL_DEPLOY_OVERRIDE=1" "ops-api"
  rm -rf "$dir"
  if [[ $GUARD_RC -ne 0 ]] && echo "$GUARD_STDERR$GUARD_STDOUT" | grep -qiE 'not on main|main only|must be on main'; then
    pass "$name"
  else
    fail "$name" "expected nonzero exit and 'not on main' message; rc=$GUARD_RC stderr=$GUARD_STDERR"
  fi
}

# Test 4: Override + clean main proceeds (exit 0, "proceeding" message)
test_override_clean_main() {
  local name="test_override_clean_main"
  local dir
  dir="$(mk_temp_repo main)"
  run_guard "$dir" "ALLOW_MANUAL_DEPLOY_OVERRIDE=1" "ops-api"
  rm -rf "$dir"
  if [[ $GUARD_RC -eq 0 ]] && echo "$GUARD_STDERR$GUARD_STDOUT" | grep -qiE 'proceed|confirm|safety checks passed'; then
    pass "$name"
  else
    fail "$name" "expected exit 0 and 'proceed/confirm' message; rc=$GUARD_RC stderr=$GUARD_STDERR stdout=$GUARD_STDOUT"
  fi
}

# Test 5: Override path logs loudly to stderr with OVERRIDE keyword and git ref
test_override_logs_loudly() {
  local name="test_override_logs_loudly"
  local dir
  dir="$(mk_temp_repo main)"
  run_guard "$dir" "ALLOW_MANUAL_DEPLOY_OVERRIDE=1" "ops-api"
  local head_sha
  head_sha="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo unknown)"
  rm -rf "$dir"
  local has_keyword has_ref
  has_keyword=0
  has_ref=0
  echo "$GUARD_STDERR" | grep -qE 'OVERRIDE|MANUAL DEPLOY' && has_keyword=1
  echo "$GUARD_STDERR" | grep -qE "${head_sha:0:7}|main" && has_ref=1
  if [[ $has_keyword -eq 1 ]] && [[ $has_ref -eq 1 ]]; then
    pass "$name"
  else
    fail "$name" "stderr missing OVERRIDE keyword or git ref; has_keyword=$has_keyword has_ref=$has_ref stderr=$GUARD_STDERR"
  fi
}

# Test 6: Variable-form invocation is still caught
test_variable_form() {
  local name="test_variable_form"
  local FN
  FN=ops-api
  local rc out err
  out="$(cd "$REPO_ROOT" && bash "$GUARD_SCRIPT" $FN 2>/tmp/.deploy-edge-stderr.$$)"
  rc=$?
  err="$(cat /tmp/.deploy-edge-stderr.$$ 2>/dev/null)"
  rm -f /tmp/.deploy-edge-stderr.$$
  if [[ $rc -ne 0 ]] && echo "$err$out" | grep -qiE 'BLOCKED|refused|manual deploy'; then
    pass "$name"
  else
    fail "$name" "variable-form bypass not caught; rc=$rc out=$out err=$err"
  fi
}

main() {
  require_script
  echo "Running deploy-edge.sh shell tests..."
  echo

  test_bare_refusal
  test_override_dirty_tree
  test_override_non_main
  test_override_clean_main
  test_override_logs_loudly
  test_variable_form

  echo
  echo "Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo "Failed tests:" >&2
    printf '  %s\n' "${FAILED_TESTS[@]}" >&2
    exit 1
  fi
  echo "All tests passed."
  exit 0
}

main "$@"
