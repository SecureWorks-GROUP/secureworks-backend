#!/bin/bash
# Manual edge function deploy guard.
#
# This script is the ONLY supported entry point for a manual
# `supabase functions deploy`. By default it refuses. Bypass requires
# ALLOW_MANUAL_DEPLOY_OVERRIDE=1 AND a clean working tree on main with no
# remote drift. Override invocations log a loud banner to stderr.
#
# The production deploy lane is: open PR → CI passes → merge → auto-deploy.
# This guard exists so a stale terminal cannot silently overwrite live code
# from this Mac.

set -euo pipefail

FUNCTION_NAME="${1:-}"
SUPABASE_BIN="${SUPABASE_BIN:-supabase}"
PROJECT_REF="${PROJECT_REF:-kevgrhcjxspbxgovpmfl}"

refusal_banner() {
  cat >&2 <<'EOF'
============================================================
BLOCKED: manual `supabase functions deploy` is refused.

The only supported production deploy path is:
    open PR → CI passes → merge → auto-deploy
See: secureworks-docs/architecture/deploy-lane.md

To bypass this guard for an emergency, set:
    ALLOW_MANUAL_DEPLOY_OVERRIDE=1
The override path still enforces safety checks (clean tree,
on main, no remote drift) and logs a loud audit banner.
============================================================
EOF
}

dirty_banner() {
  echo "BLOCKED: working tree is dirty. Commit or stash before manual deploy." >&2
  git status --short >&2 || true
}

not_on_main_banner() {
  local branch="$1"
  echo "BLOCKED: not on main (currently on '${branch}'). Manual deploy must be on main." >&2
}

drift_banner() {
  local head="$1" origin="$2"
  echo "BLOCKED: remote drift — HEAD does not match origin/main." >&2
  echo "  HEAD:        ${head}" >&2
  echo "  origin/main: ${origin}" >&2
}

override_banner() {
  local head="$1" branch="$2" fn="$3"
  cat >&2 <<EOF
============================================================
  MANUAL DEPLOY OVERRIDE INVOKED
============================================================
This deploy is bypassing the PR-only production lane.
It must be reviewed after the fact (see rulebook).

  git ref:    ${head}
  git branch: ${branch}
  function:   ${fn}
  user:       $(whoami)
  host:       $(hostname)
  time:       $(date -u +%Y-%m-%dT%H:%M:%SZ)
============================================================
EOF
}

if [[ "${ALLOW_MANUAL_DEPLOY_OVERRIDE:-}" != "1" ]]; then
  refusal_banner
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "BLOCKED: not inside a git working tree." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain 2>/dev/null || echo failed)" ]]; then
  dirty_banner
  exit 1
fi

current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [[ "$current_branch" != "main" ]]; then
  not_on_main_banner "$current_branch"
  exit 1
fi

if git rev-parse --verify --quiet origin/main >/dev/null; then
  git fetch origin --prune >/dev/null 2>&1 || true
  head_sha="$(git rev-parse HEAD)"
  origin_sha="$(git rev-parse origin/main)"
  if [[ "$head_sha" != "$origin_sha" ]]; then
    drift_banner "$head_sha" "$origin_sha"
    exit 1
  fi
fi

git_ref="$(git rev-parse HEAD)"
git_branch="$(git rev-parse --abbrev-ref HEAD)"

override_banner "$git_ref" "$git_branch" "${FUNCTION_NAME:-<unspecified>}"

if [[ -z "$FUNCTION_NAME" ]]; then
  echo "Safety checks passed but no function name was provided." >&2
  echo "Usage: ALLOW_MANUAL_DEPLOY_OVERRIDE=1 $0 <function-name>" >&2
  exit 2
fi

if [[ "${DEPLOY_EDGE_CONFIRM:-}" != "1" ]]; then
  cat >&2 <<EOF
Safety checks passed. Override path reached confirmation gate.
To actually invoke supabase, re-run with:
    DEPLOY_EDGE_CONFIRM=1 ALLOW_MANUAL_DEPLOY_OVERRIDE=1 \\
      bash scripts/deploy-edge.sh ${FUNCTION_NAME}
Proceeding to exit without invoking supabase.
EOF
  exit 0
fi

echo "Invoking: ${SUPABASE_BIN} functions deploy ${FUNCTION_NAME} --no-verify-jwt --project-ref ${PROJECT_REF}" >&2
exec "$SUPABASE_BIN" functions deploy "$FUNCTION_NAME" --no-verify-jwt --project-ref "$PROJECT_REF"
