#!/usr/bin/env bash
# Regression tests for verification-only production edge workflow runs.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLASSIFIER="$REPO_ROOT/scripts/identify-edge-deploy-changes.sh"
DEPLOY_WORKFLOW="$REPO_ROOT/.github/workflows/deploy-edge-functions.yml"
PR_WORKFLOW="$REPO_ROOT/.github/workflows/pr-check.yml"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()
TEST_TMP="$(mktemp -d 2>/dev/null || mktemp -d -t edge-workflow-test)"

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

output_value() {
  local output_file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$output_file" | tail -1
}

run_classifier() {
  local repo="$1"
  local before_sha="$2"
  local head_sha="$3"
  local event_name="$4"
  local output_file="$5"

  : > "$output_file"
  (
    cd "$repo" || exit 99
    BEFORE_SHA="$before_sha" \
      HEAD_SHA="$head_sha" \
      EVENT_NAME="$event_name" \
      GITHUB_OUTPUT="$output_file" \
      bash scripts/identify-edge-deploy-changes.sh
  )
}

make_fixture_repo() {
  local repo
  repo="$(mktemp -d "$TEST_TMP/repo.XXXXXX")"
  mkdir -p \
    "$repo/.github/workflows" \
    "$repo/scripts" \
    "$repo/supabase/functions/ops-api" \
    "$repo/supabase/functions/send-quote"

  cp "$CLASSIFIER" "$repo/scripts/identify-edge-deploy-changes.sh"
  printf '%s\n' 'base ops-api' > "$repo/supabase/functions/ops-api/index.ts"
  printf '%s\n' 'base send-quote' > "$repo/supabase/functions/send-quote/index.ts"
  printf '%s\n' '# base smoke' > "$repo/scripts/smoke-ops-api-action-surface.sh"
  printf '%s\n' '# base source check' > "$repo/scripts/check-ops-api-source-actions.sh"
  printf '%s\n' 'ops_api_version' > "$repo/scripts/_ops-api-required-actions.txt"
  printf '%s\n' 'name: fixture' > "$repo/.github/workflows/deploy-edge-functions.yml"

  (
    cd "$repo" || exit 1
    git init -q -b main >/dev/null 2>&1 || {
      git init -q
      git checkout -q -b main
    }
    git config user.email test@example.com
    git config user.name test
    git add .
    git commit -q -m base
  )

  printf '%s\n' "$repo"
}

test_scripts_only_change_requests_verification_without_deploy() {
  local name="test_scripts_only_change_requests_verification_without_deploy"
  local repo output base_sha head_sha
  repo="$(make_fixture_repo)"
  output="$TEST_TMP/scripts-only.out"

  (
    cd "$repo" || exit 1
    base_sha="$(git rev-parse HEAD)"
    printf '%s\n' '# repaired smoke' >> scripts/smoke-ops-api-action-surface.sh
    git add scripts/smoke-ops-api-action-surface.sh
    git commit -q -m verification-only
    head_sha="$(git rev-parse HEAD)"
    printf '%s\n%s\n' "$base_sha" "$head_sha" > "$TEST_TMP/scripts-only-shas"
  )
  base_sha="$(sed -n '1p' "$TEST_TMP/scripts-only-shas")"
  head_sha="$(sed -n '2p' "$TEST_TMP/scripts-only-shas")"

  if ! run_classifier "$repo" "$base_sha" "$head_sha" push "$output"; then
    fail "$name" "classifier failed for a scripts-only push"
    return
  fi

  if [[ -n "$(output_value "$output" functions)" ]]; then
    fail "$name" "scripts-only change selected a function for deploy: $(output_value "$output" functions)"
    return
  fi
  if [[ "$(output_value "$output" function_source_changed)" != "false" ]]; then
    fail "$name" "scripts-only change was not distinguished from function source"
    return
  fi
  if [[ "$(output_value "$output" verification_only)" != "true" ]]; then
    fail "$name" "scripts-only change was not classified as verification-only"
    return
  fi
  if [[ "$(output_value "$output" verify_ops_api)" != "true" ]]; then
    fail "$name" "scripts-only change did not request ops-api verification"
    return
  fi

  pass "$name"
}

test_ops_api_source_change_preserves_deploy_and_verification() {
  local name="test_ops_api_source_change_preserves_deploy_and_verification"
  local repo output base_sha head_sha
  repo="$(make_fixture_repo)"
  output="$TEST_TMP/ops-api-source.out"

  (
    cd "$repo" || exit 1
    base_sha="$(git rev-parse HEAD)"
    printf '%s\n' 'changed ops-api' >> supabase/functions/ops-api/index.ts
    git add supabase/functions/ops-api/index.ts
    git commit -q -m ops-api-source
    head_sha="$(git rev-parse HEAD)"
    printf '%s\n%s\n' "$base_sha" "$head_sha" > "$TEST_TMP/ops-api-shas"
  )
  base_sha="$(sed -n '1p' "$TEST_TMP/ops-api-shas")"
  head_sha="$(sed -n '2p' "$TEST_TMP/ops-api-shas")"

  if ! run_classifier "$repo" "$base_sha" "$head_sha" push "$output"; then
    fail "$name" "classifier failed for an ops-api source push"
    return
  fi

  if [[ "$(output_value "$output" functions)" != "ops-api " ]]; then
    fail "$name" "ops-api source change did not select only ops-api: $(output_value "$output" functions)"
    return
  fi
  if [[ "$(output_value "$output" function_source_changed)" != "true" ]]; then
    fail "$name" "ops-api source change was not classified as function source"
    return
  fi
  if [[ "$(output_value "$output" verification_only)" != "false" ]]; then
    fail "$name" "ops-api source change was incorrectly classified as verification-only"
    return
  fi
  if [[ "$(output_value "$output" verify_ops_api)" != "true" ]]; then
    fail "$name" "ops-api source change did not preserve action verification"
    return
  fi

  pass "$name"
}

test_other_function_change_keeps_existing_deploy_scope() {
  local name="test_other_function_change_keeps_existing_deploy_scope"
  local repo output base_sha head_sha
  repo="$(make_fixture_repo)"
  output="$TEST_TMP/other-function.out"

  (
    cd "$repo" || exit 1
    base_sha="$(git rev-parse HEAD)"
    printf '%s\n' 'changed send-quote' >> supabase/functions/send-quote/index.ts
    git add supabase/functions/send-quote/index.ts
    git commit -q -m send-quote-source
    head_sha="$(git rev-parse HEAD)"
    printf '%s\n%s\n' "$base_sha" "$head_sha" > "$TEST_TMP/other-function-shas"
  )
  base_sha="$(sed -n '1p' "$TEST_TMP/other-function-shas")"
  head_sha="$(sed -n '2p' "$TEST_TMP/other-function-shas")"

  if ! run_classifier "$repo" "$base_sha" "$head_sha" push "$output"; then
    fail "$name" "classifier failed for another function source push"
    return
  fi

  if [[ "$(output_value "$output" functions)" != "send-quote " ]]; then
    fail "$name" "other function deploy scope changed: $(output_value "$output" functions)"
    return
  fi
  if [[ "$(output_value "$output" verify_ops_api)" != "false" ]]; then
    fail "$name" "unrelated function source unnecessarily requested ops-api verification"
    return
  fi

  pass "$name"
}

test_unusual_event_uses_a_valid_fallback_range() {
  local name="test_unusual_event_uses_a_valid_fallback_range"
  local repo output head_sha
  repo="$(make_fixture_repo)"
  output="$TEST_TMP/unusual.out"

  (
    cd "$repo" || exit 1
    printf '%s\n' '# manual verifier edit' >> scripts/check-ops-api-source-actions.sh
    git add scripts/check-ops-api-source-actions.sh
    git commit -q -m unusual-event
    git rev-parse HEAD > "$TEST_TMP/unusual-head"
  )
  head_sha="$(cat "$TEST_TMP/unusual-head")"

  if ! run_classifier "$repo" "" "$head_sha" workflow_dispatch "$output"; then
    fail "$name" "classifier attempted an invalid empty git diff range"
    return
  fi

  if [[ "$(output_value "$output" diff_mode)" != "head-parent-fallback" ]]; then
    fail "$name" "unusual event did not report a valid parent fallback: $(output_value "$output" diff_mode)"
    return
  fi
  if [[ "$(output_value "$output" verify_ops_api)" != "true" ]]; then
    fail "$name" "fallback range missed the verification-contract change"
    return
  fi

  pass "$name"
}

test_missing_push_base_fails_safe_without_an_invalid_diff() {
  local name="test_missing_push_base_fails_safe_without_an_invalid_diff"
  local repo output log head_sha
  repo="$(make_fixture_repo)"
  output="$TEST_TMP/missing-push-base.out"
  log="$TEST_TMP/missing-push-base.log"
  head_sha="$(cd "$repo" && git rev-parse HEAD)"

  if run_classifier \
    "$repo" \
    "1111111111111111111111111111111111111111" \
    "$head_sha" \
    push \
    "$output" > "$log" 2>&1; then
    fail "$name" "classifier accepted an unavailable push base"
    return
  fi

  if ! grep -Fq 'push base is not a valid commit' "$log"; then
    fail "$name" "classifier failed without an explicit safe-range error: $(cat "$log")"
    return
  fi

  pass "$name"
}

test_workflow_wires_verification_without_a_deploy() {
  local name="test_workflow_wires_verification_without_a_deploy"

  if ! DEPLOY_WORKFLOW="$DEPLOY_WORKFLOW" PR_WORKFLOW="$PR_WORKFLOW" node <<'NODE'
const fs = require('fs');

const deployPath = process.env.DEPLOY_WORKFLOW;
const prPath = process.env.PR_WORKFLOW;
const deploy = fs.readFileSync(deployPath, 'utf8');
const pr = fs.readFileSync(prPath, 'utf8');

function requireText(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`${label}: missing ${JSON.stringify(needle)}`);
  }
}

for (const triggerPath of [
  "scripts/identify-edge-deploy-changes.sh",
  "scripts/check-ops-api-source-actions.sh",
  "scripts/smoke-ops-api-action-surface.sh",
  "scripts/_ops-api-required-actions.txt",
  ".github/workflows/deploy-edge-functions.yml",
]) {
  requireText(deploy, `- '${triggerPath}'`, 'deploy workflow trigger');
}

requireText(deploy, 'bash scripts/identify-edge-deploy-changes.sh', 'change classifier');
requireText(deploy, "if: steps.changed.outputs.verify_ops_api == 'true'", 'source/action verification condition');
requireText(deploy, "if: steps.changed.outputs.functions != ''", 'function deploy condition');
requireText(deploy, 'bash scripts/check-ops-api-source-actions.sh', 'authoritative source check');
requireText(deploy, 'bash scripts/smoke-ops-api-action-surface.sh', 'authoritative live action smoke');

const deployStep = deploy.match(/- name: Deploy changed edge functions[\s\S]*?(?=\n      - name:)/);
if (!deployStep || !deployStep[0].includes("if: steps.changed.outputs.functions != ''")) {
  throw new Error('deploy step is not strictly gated by a non-empty function set');
}

const basicSmokeStep = deploy.match(/- name: Smoke test deployed functions[\s\S]*?(?=\n      - name:)/);
if (!basicSmokeStep || !basicSmokeStep[0].includes("if: steps.changed.outputs.functions != ''")) {
  throw new Error('basic smoke is not preserved for deployed functions');
}

const actionSmokeStep = deploy.match(/- name: Smoke test ops-api action surface[\s\S]*$/);
if (!actionSmokeStep || !actionSmokeStep[0].includes("if: steps.changed.outputs.verify_ops_api == 'true'")) {
  throw new Error('action-surface smoke does not run for verification-only changes');
}

const deployIndex = deploy.indexOf('- name: Deploy changed edge functions');
const basicSmokeIndex = deploy.indexOf('- name: Smoke test deployed functions');
const actionSmokeIndex = deploy.indexOf('- name: Smoke test ops-api action surface');
if (!(deployIndex < basicSmokeIndex && basicSmokeIndex < actionSmokeIndex)) {
  throw new Error('ops-api source path lost deploy -> basic smoke -> action-surface smoke order');
}

for (const requiredTest of [
  'bash scripts/test/test-deploy-edge-functions-workflow.sh',
  'bash scripts/test/test-smoke-ops-api-action-surface.sh',
]) {
  requireText(pr, requiredTest, 'PR workflow safety fixture');
}
NODE
  then
    fail "$name" "workflow wiring does not preserve the zero-deploy verification path"
    return
  fi

  pass "$name"
}

main() {
  echo "Running edge deploy workflow tests..."
  echo

  if [[ ! -f "$CLASSIFIER" ]]; then
    fail "test_setup" "change classifier missing: $CLASSIFIER"
  else
    test_scripts_only_change_requests_verification_without_deploy
    test_ops_api_source_change_preserves_deploy_and_verification
    test_other_function_change_keeps_existing_deploy_scope
    test_unusual_event_uses_a_valid_fallback_range
    test_missing_push_base_fails_safe_without_an_invalid_diff
  fi
  test_workflow_wires_verification_without_a_deploy

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
