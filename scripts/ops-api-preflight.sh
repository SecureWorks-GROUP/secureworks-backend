#!/usr/bin/env bash
# Read-only preflight for anyone about to touch production ops-api.
#
# This script does not deploy, mutate GitHub, or touch live business data. It
# proves the caller is in the canonical source lane and prints the live function
# metadata needed to spot drift before any implementation starts.

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-kevgrhcjxspbxgovpmfl}"
SUPABASE_CLI="${SUPABASE_CLI:-/Users/marninstobbe/.local/bin/supabase}"
CANONICAL_RELEASE_ROOT="${CANONICAL_RELEASE_ROOT:-/Users/marninstobbe/Projects/_release/secureworks-site-main}"

fail() {
  echo "FAIL $*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || fail "not inside a git repository"

repo_real="$(cd "$repo_root" && pwd -P)"
canon_real="$(cd "$CANONICAL_RELEASE_ROOT" && pwd -P)"

echo "== ops-api preflight =="
echo "repo: ${repo_real}"
echo "canonical: ${canon_real}"

[[ "$repo_real" == "$canon_real" ]] || fail "not in canonical release worktree"

git fetch origin --prune >/dev/null

head_sha="$(git rev-parse HEAD)"
origin_sha="$(git rev-parse origin/main)"
short_sha="$(git rev-parse --short HEAD)"

echo "branch: $(git branch --show-current || true)"
echo "head: ${short_sha}"
echo "origin/main: $(git rev-parse --short origin/main)"

[[ "$head_sha" == "$origin_sha" ]] || fail "HEAD does not equal origin/main"

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >&2
  fail "working tree is dirty"
fi

scripts/check-edge-deploy-guardrails.sh

echo
echo "== live function metadata =="
"$SUPABASE_CLI" functions list --project-ref "$PROJECT_REF" -o json \
  | node -e "
let s='';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  const j = JSON.parse(s);
  for (const name of ['ops-api', 'send-quote']) {
    const f = j.find(x => (x.slug || x.name) === name);
    if (!f) {
      console.log(JSON.stringify({ name, missing: true }));
      process.exitCode = 1;
      continue;
    }
    console.log(JSON.stringify({
      name,
      verify_jwt: f.verify_jwt,
      version: f.version,
      updated_at: f.updated_at ? new Date(f.updated_at).toISOString() : null,
    }, null, 2));
  }
})"

echo
echo "PASS ops-api preflight"
