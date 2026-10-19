#!/usr/bin/env bash
# The claim races run in real concurrent sessions against the contract database.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
OUTBOUND_CLAIMS_DB_URL="$CONTRACT_DATABASE_URL" \
  bash "$here/../../../../scripts/test-outbound-send-claims-concurrency.sh"
