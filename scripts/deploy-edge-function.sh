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

# Single source of truth for required ops-api actions, shared by this
# pre-deploy source-side gate and the post-deploy live binary check. Add or
# remove actions in the manifest, not here; its header documents every reader
# and the per-action post-deploy probe policy.
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

OPS_API_METADATA_FILE="supabase/functions/ops-api/deploy_metadata.ts"
OPS_API_METADATA_BACKUP=""
OPS_API_DEPLOYED_AT=""

restore_ops_api_metadata() {
  if [[ -n "$OPS_API_METADATA_BACKUP" && -f "$OPS_API_METADATA_BACKUP" ]]; then
    cp "$OPS_API_METADATA_BACKUP" "$OPS_API_METADATA_FILE"
    find "$OPS_API_METADATA_BACKUP" -delete
  fi
}
trap restore_ops_api_metadata EXIT

stamp_ops_api_bundle() {
  OPS_API_METADATA_BACKUP="$(mktemp)"
  cp "$OPS_API_METADATA_FILE" "$OPS_API_METADATA_BACKUP"
  OPS_API_DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  bash scripts/stamp-ops-api-build-metadata.sh "$head_sha" "$OPS_API_DEPLOYED_AT"
}

case "$FUNCTION_NAME" in
  ops-api)
    require_ops_actions
    stamp_ops_api_bundle
    SECUREWORKS_GUARDED_EDGE_DEPLOY=1 "$SUPABASE_CLI" functions deploy ops-api --no-verify-jwt --project-ref "$PROJECT_REF"
    ;;
  send-quote)
    SECUREWORKS_GUARDED_EDGE_DEPLOY=1 "$SUPABASE_CLI" functions deploy send-quote --no-verify-jwt --project-ref "$PROJECT_REF"
    ;;
esac

restore_ops_api_metadata
if [[ "$FUNCTION_NAME" == "ops-api" ]]; then
  EXPECTED_COMMIT_SHA="$head_sha" \
  EXPECTED_DEPLOYED_AT="$OPS_API_DEPLOYED_AT" \
    scripts/smoke-edge-functions.sh
else
  scripts/smoke-edge-functions.sh
fi
