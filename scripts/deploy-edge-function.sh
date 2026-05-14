#!/usr/bin/env bash
# Guarded production deploy for SecureWorks Supabase Edge Functions.
#
# Do not use raw `supabase functions deploy` for ops-api/send-quote. This script
# verifies that the deploy is coming from the canonical release worktree, exactly
# at origin/main, with a clean tree and the expected production action surface.

set -euo pipefail

FUNCTION_NAME="${1:-}"
PROJECT_REF="${PROJECT_REF:-kevgrhcjxspbxgovpmfl}"
SUPABASE_CLI="${SUPABASE_CLI:-/Users/marninstobbe/.local/bin/supabase}"
CANONICAL_RELEASE_ROOT="${CANONICAL_RELEASE_ROOT:-/Users/marninstobbe/Projects/_release/secureworks-site-main}"

if [[ -z "$FUNCTION_NAME" ]]; then
  echo "Usage: SW_API_KEY=... scripts/deploy-edge-function.sh <ops-api|send-quote>" >&2
  exit 2
fi

case "$FUNCTION_NAME" in
  ops-api|send-quote) ;;
  *)
    echo "Refusing to deploy unsupported function: ${FUNCTION_NAME}" >&2
    echo "This guard currently owns only ops-api and send-quote." >&2
    exit 2
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
repo_real="$(cd "$repo_root" && pwd -P)"
canon_real="$(cd "$CANONICAL_RELEASE_ROOT" && pwd -P)"

if [[ "$repo_real" != "$canon_real" ]]; then
  echo "Refusing deploy from non-release worktree:" >&2
  echo "  current:   ${repo_real}" >&2
  echo "  expected:  ${canon_real}" >&2
  exit 1
fi

git fetch origin --prune >/dev/null

head_sha="$(git rev-parse HEAD)"
origin_sha="$(git rev-parse origin/main)"
if [[ "$head_sha" != "$origin_sha" ]]; then
  echo "Refusing deploy: HEAD does not equal origin/main." >&2
  echo "  HEAD:        ${head_sha}" >&2
  echo "  origin/main: ${origin_sha}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing deploy: working tree is not clean." >&2
  git status --short >&2
  exit 1
fi

# Single source of truth for required ops-api actions. Both this script
# (pre-deploy source-side gate) and scripts/smoke-edge-functions.sh
# (post-deploy live binary check) read the same file. Add or remove actions
# there, not here.
REQUIRED_ACTIONS_FILE="${REQUIRED_ACTIONS_FILE:-scripts/_ops-api-required-actions.txt}"

# Read the canonical action list (strips comments + blank lines).
read_required_actions() {
  if [[ ! -f "$REQUIRED_ACTIONS_FILE" ]]; then
    echo "Required-actions manifest missing: $REQUIRED_ACTIONS_FILE" >&2
    exit 1
  fi
  grep -vE '^\s*(#|$)' "$REQUIRED_ACTIONS_FILE" | awk '{print $1}'
}

require_ops_actions() {
  REQUIRED_ACTIONS_FILE="$REQUIRED_ACTIONS_FILE" node <<'NODE'
const fs = require('fs');
const manifest = process.env.REQUIRED_ACTIONS_FILE;
const text = fs.readFileSync('supabase/functions/ops-api/index.ts', 'utf8');
const actions = [...new Set([...text.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(m => m[1]))];
const required = fs.readFileSync(manifest, 'utf8')
  .split('\n')
  .map(l => l.replace(/#.*$/, '').trim())
  .filter(Boolean);
const missing = required.filter(a => !actions.includes(a));
console.log(JSON.stringify({ actions: actions.length, required: required.length, missing }, null, 2));
if (missing.length) process.exit(1);
NODE
}

# Stamp commit_sha + deployed_at into the deployed function's runtime env so
# opsApiVersion() can return them and smoke-edge-functions can verify the
# binary matches the canonical commit. supabase secrets set is the supported
# path for Edge Function runtime env. If the CLI version doesn't accept the
# args, the deploy still proceeds; the smoke commit-sha assertion will then
# warn-skip instead of failing.
stamp_deploy_env() {
  local commit deployed_at
  commit="$(git rev-parse HEAD)"
  deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if "$SUPABASE_CLI" secrets set \
      "COMMIT_SHA=${commit}" \
      "DEPLOYED_AT=${deployed_at}" \
      --project-ref "$PROJECT_REF" >/dev/null 2>&1; then
    echo "Stamped deploy env: COMMIT_SHA=${commit:0:8} DEPLOYED_AT=${deployed_at}"
  else
    echo "[warn] supabase secrets set failed; commit_sha assertion in smoke will warn-skip" >&2
  fi
}

case "$FUNCTION_NAME" in
  ops-api)
    require_ops_actions
    stamp_deploy_env
    SECUREWORKS_GUARDED_EDGE_DEPLOY=1 "$SUPABASE_CLI" functions deploy ops-api --no-verify-jwt --project-ref "$PROJECT_REF"
    ;;
  send-quote)
    stamp_deploy_env
    SECUREWORKS_GUARDED_EDGE_DEPLOY=1 "$SUPABASE_CLI" functions deploy send-quote --no-verify-jwt --project-ref "$PROJECT_REF"
    ;;
esac

EXPECTED_COMMIT_SHA="$(git rev-parse HEAD)" scripts/smoke-edge-functions.sh
