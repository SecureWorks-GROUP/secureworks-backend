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
      DEPLOY_BASE_SHA="${6:-}" \
      REQUIRE_DEPLOY_BASELINE="${7:-false}" \
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
    "$repo/supabase/migrations" \
    "$repo/supabase/functions/ops-api" \
    "$repo/supabase/functions/send-quote"

  cp "$CLASSIFIER" "$repo/scripts/identify-edge-deploy-changes.sh"
  printf '%s\n' 'base ops-api' > "$repo/supabase/functions/ops-api/index.ts"
  printf '%s\n' 'base send-quote' > "$repo/supabase/functions/send-quote/index.ts"
  printf '%s\n' '# base smoke' > "$repo/scripts/smoke-ops-api-action-surface.sh"
  printf '%s\n' '# base source check' > "$repo/scripts/check-ops-api-source-actions.sh"
  printf '%s\n' 'ops_api_version' > "$repo/scripts/_ops-api-required-actions.txt"
  printf '%s\n' '-- base migration' > "$repo/supabase/migrations/20260730000000_base.sql"
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

test_migration_only_change_requests_apply_without_function_deploy() {
  local name="test_migration_only_change_requests_apply_without_function_deploy"
  local repo output base_sha head_sha
  repo="$(make_fixture_repo)"
  output="$TEST_TMP/migration-only.out"

  (
    cd "$repo" || exit 1
    base_sha="$(git rev-parse HEAD)"
    printf '%s\n' '-- migration-only change' \
      > supabase/migrations/20260731000000_migration_only.sql
    git add supabase/migrations/20260731000000_migration_only.sql
    git commit -q -m migration-only
    head_sha="$(git rev-parse HEAD)"
    printf '%s\n%s\n' "$base_sha" "$head_sha" \
      > "$TEST_TMP/migration-only-shas"
  )
  base_sha="$(sed -n '1p' "$TEST_TMP/migration-only-shas")"
  head_sha="$(sed -n '2p' "$TEST_TMP/migration-only-shas")"

  if ! run_classifier "$repo" "$base_sha" "$head_sha" push "$output"; then
    fail "$name" "classifier failed for a migration-only push"
    return
  fi

  if [[ -n "$(output_value "$output" functions)" ]]; then
    fail "$name" "migration-only change selected a function for deploy"
    return
  fi
  if [[ "$(output_value "$output" migrations_changed)" != "true" ]]; then
    fail "$name" "migration-only change did not request migration application"
    return
  fi
  if [[ "$(output_value "$output" verification_only)" != "false" ]]; then
    fail "$name" "migration-only change was misclassified as verification-only"
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

test_failed_deploy_changes_survive_a_green_migration_only_run() {
  local name="test_failed_deploy_changes_survive_a_green_migration_only_run"
  local repo output base_sha before_sha head_sha
  repo="$(make_fixture_repo)"
  output="$TEST_TMP/catchup.out"
  base_sha="$(git -C "$repo" rev-parse HEAD)"
  # Two failed deploy pushes, then a green migration repair which deployed no
  # functions. The next push must recover BOTH functions, not just its own diff.
  printf '%s\n' 'missed ops-api' >> "$repo/supabase/functions/ops-api/index.ts"
  git -C "$repo" add . && git -C "$repo" commit -q -m failed-ops-api
  printf '%s\n' 'missed send-quote' >> "$repo/supabase/functions/send-quote/index.ts"
  git -C "$repo" add . && git -C "$repo" commit -q -m failed-send-quote
  printf '%s\n' '-- migration repair' > "$repo/supabase/migrations/20260731000000_repair.sql"
  git -C "$repo" add . && git -C "$repo" commit -q -m green-migration-only
  before_sha="$(git -C "$repo" rev-parse HEAD)"
  printf '%s\n' '# baseline repair' >> "$repo/scripts/identify-edge-deploy-changes.sh"
  git -C "$repo" add . && git -C "$repo" commit -q -m repair-selection
  head_sha="$(git -C "$repo" rev-parse HEAD)"
  if ! run_classifier "$repo" "$before_sha" "$head_sha" push "$output" "$base_sha" true; then
    fail "$name" 'catch-up classification failed'; return
  fi
  if [[ "$(output_value "$output" functions)" != 'ops-api send-quote ' ||
        "$(output_value "$output" diff_base)" != "$base_sha" ||
        "$(output_value "$output" diff_mode)" != 'last-successful-deploy' ||
        "$(output_value "$output" migrations_changed)" != 'true' ]]; then
    fail "$name" 'failed deploy changes were lost behind the later push'; return
  fi
  pass "$name"
}

test_production_baseline_fails_closed() {
  local name="test_production_baseline_fails_closed"
  local repo output head_sha unrelated_sha candidate
  repo="$(make_fixture_repo)"
  output="$TEST_TMP/baseline-refusal.out"
  head_sha="$(git -C "$repo" rev-parse HEAD)"
  unrelated_sha="$(printf 'unrelated\n' | git -C "$repo" commit-tree HEAD^{tree})"
  for candidate in '' '1111111111111111111111111111111111111111' "$unrelated_sha"; do
    if run_classifier "$repo" "$head_sha" "$head_sha" push "$output" "$candidate" true; then
      fail "$name" 'missing, unavailable or non-ancestor baseline was accepted'; return
    fi
    if [[ -s "$output" ]]; then
      fail "$name" 'refusal emitted deployment outputs'; return
    fi
  done
  pass "$name"
}

test_workflow_resolves_actual_successful_deploy() {
  local name="test_workflow_resolves_actual_successful_deploy"
  if ! DEPLOY_WORKFLOW="$DEPLOY_WORKFLOW" node <<'NODE'
const fs = require('fs');
const assert = require('assert/strict');
const workflow = fs.readFileSync(process.env.DEPLOY_WORKFLOW, 'utf8');
const block = workflow.match(/- name: Resolve last successful function deploy[\s\S]*?script: \|\n([\s\S]*?)(?=\n      - name:)/);
assert.ok(block, 'baseline resolver missing');
const code = block[1].split('\n').map(line => line.replace(/^            /, '')).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const resolve = new AsyncFunction('github', 'context', 'core', code);
const sha = 'a'.repeat(40);
const run = (id, extra = {}) => ({ id, conclusion: 'success', event: 'push', head_branch: 'main', head_sha: sha, ...extra });
async function check(pages, jobs, failure) {
  const outputs = {};
  const paginate = async (route, params) => {
    assert.equal(route, 'jobs'); assert.equal(params.filter, 'latest');
    if (failure) throw new Error('history unreadable');
    return jobs[params.run_id];
  };
  paginate.iterator = async function* (route, params) {
    assert.equal(route, 'runs'); assert.equal(params.status, 'success');
    assert.equal(params.branch, 'main'); assert.equal(params.event, 'push');
    assert.equal(params.workflow_id, 'deploy-edge-functions.yml');
    // Octokit's pagination plugin normalizes the workflow_runs envelope to an
    // array on page.data, including when there is only one page.
    for (const runs of pages) yield { data: runs };
  };
  await resolve({ paginate, rest: { actions: { listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs' } } },
    { repo: { owner: 'fixture', repo: 'fixture' }, runId: 9 },
    { setOutput: (key, value) => { outputs[key] = value; }, info: () => {} });
  return outputs;
}
const job = conclusion => [{ name: 'deploy', conclusion: 'success', steps: [
  { name: 'Deploy changed edge functions', conclusion }
] }];
(async () => {
  // Skip current run, wrong branch, a failed workflow, then a green migration
  // run with a skipped deploy step. Paginate to the actual successful deploy.
  const pages = [[run(9), run(8, { head_branch: 'feature' }), run(7, { conclusion: 'failure' }), run(6)], [run(5)]];
  assert.deepEqual(await check(pages, { 6: job('skipped'), 5: job('success') }), { sha });
  await assert.rejects(check([[run(6)]], { 6: job('skipped') }), /No successful production function deploy/);
  await assert.rejects(check([[run(5)]], {}, true), /history unreadable/);
  await assert.rejects(check([[run(5, { head_sha: 'invalid' })]], { 5: job('success') }), /no valid source commit/);
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
  then
    fail "$name" 'actual deploy resolver did not preserve its history boundary'; return
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

verification_trigger_paths() {
  sed -n '1,/^jobs:/p' "$DEPLOY_WORKFLOW" |
    sed -n "s/^      - '\(.*\)'\$/\1/p" |
    grep -v '^supabase/functions/' |
    grep -v '^supabase/migrations/' || true
}

test_every_verification_trigger_path_is_classified() {
  local name="test_every_verification_trigger_path_is_classified"
  local repo output base_sha head_sha trigger_path
  local checked=0

  while IFS= read -r trigger_path; do
    [[ -n "$trigger_path" ]] || continue
    case "$trigger_path" in
      *'*'* | *'?'* | *'['*)
        fail "$name" "verification trigger path is a glob this parity check cannot exercise: $trigger_path"
        return
        ;;
    esac

    repo="$(make_fixture_repo)"
    output="$TEST_TMP/trigger-parity-${checked}.out"

    (
      cd "$repo" || exit 1
      git rev-parse HEAD > "$TEST_TMP/trigger-parity-shas"
      mkdir -p "$(dirname "$trigger_path")"
      printf '%s\n' '# trigger parity probe' >> "$trigger_path"
      git add "$trigger_path"
      git commit -q -m trigger-parity
      git rev-parse HEAD >> "$TEST_TMP/trigger-parity-shas"
    )
    base_sha="$(sed -n '1p' "$TEST_TMP/trigger-parity-shas")"
    head_sha="$(sed -n '2p' "$TEST_TMP/trigger-parity-shas")"

    if ! run_classifier "$repo" "$base_sha" "$head_sha" push "$output"; then
      fail "$name" "classifier failed for verification trigger path: $trigger_path"
      return
    fi
    if [[ "$(output_value "$output" verification_contract_changed)" != "true" ]]; then
      fail "$name" "verification trigger path is not recognised by the classifier: $trigger_path"
      return
    fi
    if [[ "$(output_value "$output" verify_ops_api)" != "true" ]]; then
      fail "$name" "verification trigger path did not request ops-api verification: $trigger_path"
      return
    fi
    if [[ -n "$(output_value "$output" functions)" ]]; then
      fail "$name" "verification trigger path selected a function for deploy: $trigger_path"
      return
    fi

    checked=$((checked + 1))
  done < <(verification_trigger_paths)

  if [[ "$checked" -eq 0 ]]; then
    fail "$name" "no verification trigger paths were parsed from $DEPLOY_WORKFLOW"
    return
  fi

  pass "$name"
}

test_workflow_wires_verification_without_a_deploy() {
  local name="test_workflow_wires_verification_without_a_deploy"

  if ! DEPLOY_WORKFLOW="$DEPLOY_WORKFLOW" PR_WORKFLOW="$PR_WORKFLOW" CLASSIFIER="$CLASSIFIER" node <<'NODE'
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
  "supabase/migrations/**",
  "scripts/identify-edge-deploy-changes.sh",
  "scripts/apply-pending-migrations.sh",
  "scripts/migration-autoapply-exclusions.txt",
  "scripts/migration-autoapply-ledger-aliases.txt",
  "scripts/check-edge-schema-preflight.sh",
  "scripts/edge-function-schema-requirements.txt",
  "scripts/check-ops-api-source-actions.sh",
  "scripts/stamp-ops-api-build-metadata.sh",
  "scripts/smoke-ops-api-action-surface.sh",
  "scripts/_ops-api-required-actions.txt",
  ".github/workflows/deploy-edge-functions.yml",
]) {
  requireText(deploy, `- '${triggerPath}'`, 'deploy workflow trigger');
}

requireText(deploy, 'bash scripts/identify-edge-deploy-changes.sh', 'change classifier');
requireText(deploy, 'actions: read', 'read-only deploy history permission');
requireText(deploy, 'DEPLOY_BASE_SHA: ${{ steps.deployed.outputs.sha }}', 'successful deploy baseline');
requireText(deploy, "REQUIRE_DEPLOY_BASELINE: 'true'", 'mandatory production baseline');
if (deploy.includes('github.event.before')) throw new Error('production still uses the previous push as its baseline');
requireText(deploy, "if: steps.changed.outputs.functions != ''", 'function deploy condition');
requireText(
  deploy,
  "steps.changed.outputs.migrations_changed == 'true'",
  'migration-only apply condition',
);
requireText(deploy, 'bash scripts/apply-pending-migrations.sh', 'migration auto-apply');
requireText(deploy, 'bash scripts/check-edge-schema-preflight.sh', 'production schema preflight');
requireText(deploy, 'SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}', 'schema preflight credential');
requireText(deploy, 'bash scripts/check-ops-api-source-actions.sh', 'authoritative source check');
requireText(deploy, 'bash scripts/stamp-ops-api-build-metadata.sh', 'bundled deploy metadata');
requireText(deploy, 'bash scripts/smoke-ops-api-action-surface.sh', 'authoritative live action smoke');
requireText(deploy, 'EXPECTED_OPS_API_COMMIT_SHA=', 'bundled commit smoke binding');
requireText(deploy, 'EXPECTED_OPS_API_DEPLOYED_AT=', 'bundled timestamp smoke binding');

const migrationApplyStep = deploy.match(/- name: Apply pending reviewed migrations[\s\S]*?(?=\n      - name:)/);
if (
  !migrationApplyStep ||
  !migrationApplyStep[0].includes("steps.changed.outputs.functions != ''") ||
  !migrationApplyStep[0].includes("steps.changed.outputs.migrations_changed == 'true'")
) {
  throw new Error('migration auto-apply is not required for function and migration-only pushes');
}
if (!migrationApplyStep[0].includes('bash scripts/apply-pending-migrations.sh')) {
  throw new Error('migration auto-apply does not run the authoritative runner');
}

const schemaPreflightStep = deploy.match(/- name: Post-apply check required production schema[\s\S]*?(?=\n      - (?:uses:|name:))/);
if (!schemaPreflightStep || !schemaPreflightStep[0].includes("if: steps.changed.outputs.functions != ''")) {
  throw new Error('production schema preflight is not required for every function deploy');
}
if (!schemaPreflightStep[0].includes('bash scripts/check-edge-schema-preflight.sh')) {
  throw new Error('production schema preflight does not run the authoritative guard');
}

const preDeployCheckStep = deploy.match(/- name: Pre-deploy check ops-api source action surface[\s\S]*?(?=\n      - name:)/);
if (!preDeployCheckStep || !preDeployCheckStep[0].includes("if: steps.changed.outputs.verify_ops_api == 'true'")) {
  throw new Error('pre-deploy source check does not run for verification-only changes');
}
if (!preDeployCheckStep[0].includes('bash scripts/check-ops-api-source-actions.sh')) {
  throw new Error('pre-deploy source check does not run the authoritative source check');
}

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

const migrationApplyIndex = deploy.indexOf('- name: Apply pending reviewed migrations');
const schemaPreflightIndex = deploy.indexOf('- name: Post-apply check required production schema');
const preDeployCheckIndex = deploy.indexOf('- name: Pre-deploy check ops-api source action surface');
const deployIndex = deploy.indexOf('- name: Deploy changed edge functions');
const basicSmokeIndex = deploy.indexOf('- name: Smoke test deployed functions');
const actionSmokeIndex = deploy.indexOf('- name: Smoke test ops-api action surface');
if (!(migrationApplyIndex < schemaPreflightIndex && schemaPreflightIndex < preDeployCheckIndex && preDeployCheckIndex < deployIndex && deployIndex < basicSmokeIndex && basicSmokeIndex < actionSmokeIndex)) {
  throw new Error('ops-api source path lost migration apply -> schema preflight -> source check -> deploy -> basic smoke -> action-surface smoke order');
}
requireText(deploy, 'group: production-edge-deploy-${{ github.repository }}', 'serialized production deploy concurrency');
requireText(deploy, 'cancel-in-progress: false', 'non-cancelling production deploy concurrency');

const triggerBlock = deploy.match(/\n    paths:\n((?:      - '[^']*'\n)+)/);
if (!triggerBlock) {
  throw new Error('deploy workflow push trigger has no parseable paths list');
}
const verificationTriggerPaths = triggerBlock[1]
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line.replace(/^- '/, '').replace(/'$/, ''))
  .filter((triggerPath) => !triggerPath.startsWith('supabase/functions/'))
  .filter((triggerPath) => !triggerPath.startsWith('supabase/migrations/'))
  .sort();

const classifierSource = fs.readFileSync(process.env.CLASSIFIER, 'utf8');
const contractArm = classifierSource.match(
  /is_verification_contract_path\(\)[\s\S]*?case "\$1" in\s*([\s\S]*?)\)\s*\n\s*return 0/
);
if (!contractArm) {
  throw new Error('classifier verification-contract path list is not parseable');
}
const classifierContractPaths = contractArm[1]
  .split('|')
  .map((entry) => entry.replace(/\\/g, '').trim())
  .filter(Boolean)
  .sort();

if (JSON.stringify(verificationTriggerPaths) !== JSON.stringify(classifierContractPaths)) {
  throw new Error(
    `verification trigger paths drifted from the classifier contract list: ` +
      `${JSON.stringify(verificationTriggerPaths)} vs ${JSON.stringify(classifierContractPaths)}`
  );
}

for (const requiredTest of [
  'bash scripts/test/test-deploy-edge-functions-workflow.sh',
  'bash scripts/test/test-apply-pending-migrations.sh',
  'bash scripts/test/test-edge-schema-preflight.sh',
  'bash scripts/test/test-smoke-ops-api-action-surface.sh',
  'bash scripts/test/test-stamp-ops-api-build-metadata.sh',
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
    test_migration_only_change_requests_apply_without_function_deploy
    test_ops_api_source_change_preserves_deploy_and_verification
    test_other_function_change_keeps_existing_deploy_scope
    test_failed_deploy_changes_survive_a_green_migration_only_run
    test_production_baseline_fails_closed
    test_workflow_resolves_actual_successful_deploy
    test_unusual_event_uses_a_valid_fallback_range
    test_missing_push_base_fails_safe_without_an_invalid_diff
    test_every_verification_trigger_path_is_classified
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
