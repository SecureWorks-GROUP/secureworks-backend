#!/usr/bin/env bash
# Install a local Supabase CLI wrapper that blocks stale production edge deploys.
#
# This protects old Claude/Codex/Shaun/Marnin terminals on this Mac. It only
# intercepts `supabase functions deploy ops-api|send-quote`; every other
# Supabase command passes through to the real CLI.

set -euo pipefail

SUPABASE_BIN="${SUPABASE_BIN:-/Users/marninstobbe/.local/bin/supabase}"
REAL_BIN="${REAL_BIN:-/Users/marninstobbe/.local/bin/supabase.real}"
CANONICAL_RELEASE_ROOT="${CANONICAL_RELEASE_ROOT:-/Users/marninstobbe/Projects/_release/secureworks-site-main}"

if [[ ! -x "$SUPABASE_BIN" ]]; then
  echo "Supabase CLI not found or not executable: ${SUPABASE_BIN}" >&2
  exit 1
fi

if [[ -e "$REAL_BIN" ]]; then
  echo "Real Supabase CLI already exists: ${REAL_BIN}"
else
  mv "$SUPABASE_BIN" "$REAL_BIN"
  echo "Moved real Supabase CLI to ${REAL_BIN}"
fi

cat > "$SUPABASE_BIN" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail

REAL_BIN="${SUPABASE_REAL_BIN:-/Users/marninstobbe/.local/bin/supabase.real}"
CANONICAL_RELEASE_ROOT="${CANONICAL_RELEASE_ROOT:-/Users/marninstobbe/Projects/_release/secureworks-site-main}"

is_protected_edge_deploy() {
  [[ "${1:-}" == "functions" ]] || return 1
  [[ "${2:-}" == "deploy" ]] || return 1
  [[ "${3:-}" == "ops-api" || "${3:-}" == "send-quote" ]] || return 1
}

if is_protected_edge_deploy "$@"; then
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  repo_real="$(cd "$repo_root" && pwd -P)"
  canon_real="$(cd "$CANONICAL_RELEASE_ROOT" && pwd -P)"

  if [[ "$repo_real" != "$canon_real" ]]; then
    cat >&2 <<EOF
BLOCKED: refusing to deploy ${3} from a non-canonical folder.

Production ${3} deploys are allowed only from:
  ${canon_real}

Use:
  cd ${canon_real}
  SW_API_KEY=... scripts/deploy-edge-function.sh ${3}

This guard prevents stale worktrees from overwriting the live Supabase function.
EOF
    exit 1
  fi

  git fetch origin --prune >/dev/null
  head_sha="$(git rev-parse HEAD)"
  origin_sha="$(git rev-parse origin/main)"
  if [[ "$head_sha" != "$origin_sha" ]]; then
    cat >&2 <<EOF
BLOCKED: refusing to deploy ${3}; canonical worktree is not exactly origin/main.

  HEAD:        ${head_sha}
  origin/main: ${origin_sha}

Merge/rebase through GitHub first, then deploy from the release lane.
EOF
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "BLOCKED: refusing to deploy ${3}; canonical worktree is dirty." >&2
    git status --short >&2
    exit 1
  fi

  case " $* " in
    *" --no-verify-jwt "*) ;;
    *)
      echo "BLOCKED: ${3} must deploy with --no-verify-jwt." >&2
      echo "Use: SW_API_KEY=... scripts/deploy-edge-function.sh ${3}" >&2
      exit 1
      ;;
  esac
fi

exec "$REAL_BIN" "$@"
WRAPPER

chmod +x "$SUPABASE_BIN"

"$SUPABASE_BIN" --version >/dev/null
echo "Installed Supabase edge deploy guard at ${SUPABASE_BIN}"
echo "Real Supabase CLI: ${REAL_BIN}"
