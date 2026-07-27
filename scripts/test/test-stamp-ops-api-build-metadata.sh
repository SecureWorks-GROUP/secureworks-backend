#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMPER="${REPO_ROOT}/scripts/stamp-ops-api-build-metadata.sh"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t ops-api-metadata-test)"
trap 'find "$TMP_DIR" -depth -delete' EXIT

TARGET="${TMP_DIR}/deploy_metadata.ts"
COMMIT="abcdef0123456789abcdef0123456789abcdef01"
DEPLOYED_AT="2026-07-27T10:11:12Z"

OPS_API_DEPLOY_METADATA_FILE="$TARGET" \
  bash "$STAMPER" "$COMMIT" "$DEPLOYED_AT"

grep -Fq "commit_sha: \"${COMMIT}\"" "$TARGET"
grep -Fq "deployed_at: \"${DEPLOYED_AT}\"" "$TARGET"

if OPS_API_DEPLOY_METADATA_FILE="$TARGET" \
  bash "$STAMPER" "not-a-sha" "$DEPLOYED_AT" >/dev/null 2>&1; then
  echo "FAIL: invalid commit SHA was accepted" >&2
  exit 1
fi

if OPS_API_DEPLOY_METADATA_FILE="$TARGET" \
  bash "$STAMPER" "$COMMIT" "not-a-timestamp" >/dev/null 2>&1; then
  echo "FAIL: invalid deploy timestamp was accepted" >&2
  exit 1
fi

echo "PASS: bundled ops-api deploy metadata is exact and validated"
