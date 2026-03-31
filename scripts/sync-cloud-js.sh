#!/bin/bash
# Sync cloud.js from canonical source to all repos
# Canonical: ~/Projects/patio-tool/tools/shared/cloud.js

set -euo pipefail

CANONICAL="$HOME/Projects/patio-tool/tools/shared/cloud.js"

if [ ! -f "$CANONICAL" ]; then
  echo "ERROR: Canonical cloud.js not found at $CANONICAL"
  exit 1
fi

echo "Syncing cloud.js from $CANONICAL"
echo "  SHA: $(shasum -a 256 "$CANONICAL" | cut -c1-12)"

TARGETS=(
  "$HOME/Projects/fence-designer/cloud.js"
  "$HOME/Projects/securedash-temp/dashboard/cloud.js"
  "$HOME/Projects/secureworks-sale/cloud.js"
)

for t in "${TARGETS[@]}"; do
  if [ -d "$(dirname "$t")" ]; then
    cp "$CANONICAL" "$t"
    echo "  Synced -> $t"
  else
    echo "  SKIP  -> $t (directory not found)"
  fi
done

echo "Done."
