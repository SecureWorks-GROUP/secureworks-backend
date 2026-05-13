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

require_ops_actions() {
  node <<'NODE'
const fs = require('fs');
const text = fs.readFileSync('supabase/functions/ops-api/index.ts', 'utf8');
const actions = [...new Set([...text.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(m => m[1]))];
const required = [
  'ops_api_version',
  'list_ops_notes',
  'list_proposed_actions',
  'send_quote_followup_sms',
  'approve_scoper_call_task',
  'approve_quote_review_task',
  'list_stale_quote_review_tasks',
  'finance_health_summary',
  'daily_coverage_audit',
  'freeze_scope',
  'record_scope_artifact',
  'get_evidence_health',
];
const missing = required.filter(a => !actions.includes(a));
console.log(JSON.stringify({ actions: actions.length, missing }, null, 2));
if (missing.length) process.exit(1);
NODE
}

case "$FUNCTION_NAME" in
  ops-api)
    require_ops_actions
    "$SUPABASE_CLI" functions deploy ops-api --no-verify-jwt --project-ref "$PROJECT_REF"
    ;;
  send-quote)
    "$SUPABASE_CLI" functions deploy send-quote --no-verify-jwt --project-ref "$PROJECT_REF"
    ;;
esac

scripts/smoke-edge-functions.sh
