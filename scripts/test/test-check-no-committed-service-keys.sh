#!/usr/bin/env bash
# Tests scripts/check-no-committed-service-keys.sh against throwaway git repos.
# Every key here is built at run time from fake claims and a fake signature, so
# this file never carries a key-shaped literal of its own.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/../check-no-committed-service-keys.sh"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t service-key-check)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL test-check-no-committed-service-keys: $*" >&2
  exit 1
}

b64url() {
  printf '%s' "$1" | base64 | tr -d '=\n' | tr '/+' '_-'
}

fake_jwt() {
  printf '%s.%s.%s' "$(b64url '{"alg":"HS256","typ":"JWT"}')" "$(b64url "$1")" "c2lnbmF0dXJlLW5vdC1yZWFs"
}

SERVICE_JWT="$(fake_jwt '{"iss":"supabase","ref":"example","role":"service_role"}')"
ANON_JWT="$(fake_jwt '{"iss":"supabase","ref":"example","role":"anon"}')"
SECRET_KEY="sb_secret_$(printf 'fake%.0s' 1 2 3 4 5 6)"

new_repo() {
  local dir="$TMP_DIR/$1"
  mkdir -p "$dir"
  git -C "$dir" init --quiet
  git -C "$dir" config user.email test@example.invalid
  git -C "$dir" config user.name test
  printf '%s\n' "$dir"
}

run_check() {
  local dir="$1"
  shift
  set +e
  OUTPUT=$(cd "$dir" && bash "$CHECK" "$@" 2>&1)
  STATUS=$?
  set -e
  if grep -Fq -- "$SERVICE_JWT" <<< "$OUTPUT" || grep -Fq -- "$SECRET_KEY" <<< "$OUTPUT"; then
    fail "output printed a key"
  fi
}

# 1. Clean repo, and a repo carrying only the public anon key, both pass.
repo="$(new_repo clean)"
printf 'nothing here\n' > "$repo/a.txt"
git -C "$repo" add a.txt
run_check "$repo"
[[ "$STATUS" -eq 0 ]] || fail "clean repo failed: $OUTPUT"

repo="$(new_repo anon)"
printf 'window.SUPABASE_ANON_KEY = "%s";\n' "$ANON_JWT" > "$repo/config.js"
git -C "$repo" add config.js
run_check "$repo"
[[ "$STATUS" -eq 0 ]] || fail "anon key was refused: $OUTPUT"

# 2. A tracked service_role JWT fails, naming file and line only.
repo="$(new_repo service)"
printf 'line one\nheaders: "Bearer %s"\n' "$SERVICE_JWT" > "$repo/cron.sql"
git -C "$repo" add cron.sql
run_check "$repo"
[[ "$STATUS" -eq 1 ]] || fail "service_role JWT passed: $OUTPUT"
grep -Fq 'cron.sql:2: JWT with role service_role' <<< "$OUTPUT" || fail "finding lacks file:line: $OUTPUT"

# 3. An sb_secret_ key fails.
repo="$(new_repo secret)"
printf 'const key = "%s";\n' "$SECRET_KEY" > "$repo/key.ts"
git -C "$repo" add key.ts
run_check "$repo"
[[ "$STATUS" -eq 1 ]] || fail "sb_secret_ key passed: $OUTPUT"
grep -Fq 'key.ts:1: sb_secret_ key' <<< "$OUTPUT" || fail "finding lacks file:line: $OUTPUT"

# 4. --cached checks what is staged: a key staged and then removed from the
#    working tree still fails, and an untracked key is out of scope.
repo="$(new_repo cached)"
printf 'Bearer %s\n' "$SERVICE_JWT" > "$repo/staged.sql"
git -C "$repo" add staged.sql
printf 'clean now\n' > "$repo/staged.sql"
printf 'Bearer %s\n' "$SERVICE_JWT" > "$repo/untracked.sql"
run_check "$repo" --cached
[[ "$STATUS" -eq 1 ]] || fail "--cached missed a staged key: $OUTPUT"
grep -Fq 'staged.sql:1:' <<< "$OUTPUT" || fail "--cached finding lacks the staged path: $OUTPUT"
if grep -Fq 'untracked.sql' <<< "$OUTPUT"; then
  fail "untracked file was scanned"
fi

# 5. Unknown arguments are refused.
run_check "$repo" --everything
[[ "$STATUS" -eq 64 ]] || fail "unknown argument accepted: $OUTPUT"

echo "PASS test-check-no-committed-service-keys"
