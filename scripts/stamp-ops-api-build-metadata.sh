#!/usr/bin/env bash
set -euo pipefail

commit_sha="${1:-}"
deployed_at="${2:-}"
target="${OPS_API_DEPLOY_METADATA_FILE:-supabase/functions/ops-api/deploy_metadata.ts}"

if [[ ! "$commit_sha" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
  echo "Invalid ops-api deploy commit SHA: ${commit_sha}" >&2
  exit 2
fi
if [[ ! "$deployed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "Invalid ops-api deploy timestamp: ${deployed_at}" >&2
  exit 2
fi

mkdir -p "$(dirname "$target")"
{
  echo "// Generated immediately before ops-api bundling. Do not commit stamped values."
  echo "export const OPS_API_DEPLOY_METADATA = {"
  echo "  commit_sha: \"${commit_sha}\","
  echo "  deployed_at: \"${deployed_at}\","
  echo "} as const;"
} > "$target"

echo "Stamped bundled ops-api metadata: ${commit_sha:0:8} ${deployed_at}"
