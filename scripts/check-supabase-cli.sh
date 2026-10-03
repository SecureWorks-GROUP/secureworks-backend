#!/usr/bin/env bash
# Fail unless the `supabase` on PATH can really run, not only print a version.
#
# 1. `supabase --version` must succeed and, when SUPABASE_CLI_EXPECTED_VERSION
#    is set, print exactly that version.
# 2. A delegated, local-only command must succeed. From 2.105 the `supabase`
#    shim answers --version/--help itself and passes every other command to
#    `supabase-go`; a missing `supabase-go` only shows up here.
#    `functions new` writes a stub function into a throwaway directory and
#    touches no project, credential or network service of ours.

set -euo pipefail

fail() {
  echo "FAIL supabase CLI: $*" >&2
  exit 1
}

command -v supabase >/dev/null 2>&1 || fail "supabase is not on PATH"

version="$(supabase --version 2>/dev/null)" || fail "'supabase --version' exited non-zero"
version="$(printf '%s\n' "$version" | tail -1 | tr -d '[:space:]')"
[[ -n "$version" ]] || fail "'supabase --version' printed nothing"
if [[ -n "${SUPABASE_CLI_EXPECTED_VERSION:-}" && "$version" != "$SUPABASE_CLI_EXPECTED_VERSION" ]]; then
  fail "version is $version, expected $SUPABASE_CLI_EXPECTED_VERSION"
fi

probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
if ! (cd "$probe" && HOME="$probe" DO_NOT_TRACK=1 supabase functions new cli-probe >"$probe/out.log" 2>&1); then
  cat "$probe/out.log" >&2
  fail "a delegated command ('supabase functions new') failed; is supabase-go installed beside supabase?"
fi
[[ -f "$probe/supabase/functions/cli-probe/index.ts" ]] ||
  fail "'supabase functions new' succeeded but wrote no function"

echo "PASS supabase CLI $version runs delegated commands"
