#!/usr/bin/env bash
# Install the pinned Supabase CLI for GitLab CI (linux amd64) and prove it runs.
#
# Since 2.105 the release tarball ships two executables: `supabase` (a shim)
# and `supabase-go` (the real CLI). The shim answers `--version` and `--help`
# on its own but hands every real command, `functions deploy` included, to
# `supabase-go` beside it. Extracting only `supabase` therefore passes a
# version check and then fails every deploy with "Could not find the
# supabase-go binary" (GitLab main pipelines #25, #26 and #29). So this
# extracts the WHOLE tarball into one directory on PATH, verifies the
# published checksum first, and then runs scripts/check-supabase-cli.sh,
# which exercises a delegated command, not only `--version`.
#
# Usage: bash scripts/install-supabase-cli.sh [install-dir]   (default /usr/local/bin)

set -euo pipefail

# Pinned. Change all three together; the checksum is the release's own
# checksums.txt entry for this tarball.
SUPABASE_CLI_VERSION=2.105.0
SUPABASE_CLI_TARBALL="supabase_${SUPABASE_CLI_VERSION}_linux_amd64.tar.gz"
SUPABASE_CLI_SHA256=11ac4410c11e8b03f0cc7fd9316d68146695b0e06115a0663364b07e7feb6db8

INSTALL_DIR="${1:-/usr/local/bin}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/$SUPABASE_CLI_TARBALL" \
  "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/${SUPABASE_CLI_TARBALL}"
echo "${SUPABASE_CLI_SHA256}  $work/$SUPABASE_CLI_TARBALL" | sha256sum -c -

mkdir -p "$INSTALL_DIR"
tar -xzf "$work/$SUPABASE_CLI_TARBALL" -C "$INSTALL_DIR"
echo "Installed into $INSTALL_DIR: $(tar -tzf "$work/$SUPABASE_CLI_TARBALL" | tr '\n' ' ')"

SUPABASE_CLI_EXPECTED_VERSION="$SUPABASE_CLI_VERSION" \
  PATH="$INSTALL_DIR:$PATH" bash "$SCRIPT_DIR/check-supabase-cli.sh"
