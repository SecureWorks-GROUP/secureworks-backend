#!/usr/bin/env bash
# Apply/re-apply and test the inert make-safe case migration against a disposable
# production-schema clone. This script deliberately refuses the live project.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
URL=${MAKESAFE_PROD_SCHEMA_CLONE_URL:-}
ACK=${MAKESAFE_PROD_SCHEMA_CLONE_ACK:-}

if [ -z "$URL" ]; then
  echo "error: set MAKESAFE_PROD_SCHEMA_CLONE_URL to a disposable prod-schema clone" >&2
  exit 2
fi
if [ "$ACK" != "I-confirm-this-is-a-disposable-prod-schema-clone" ]; then
  echo "error: set MAKESAFE_PROD_SCHEMA_CLONE_ACK=I-confirm-this-is-a-disposable-prod-schema-clone" >&2
  exit 2
fi
case "$URL" in
  *kevgrhcjxspbxgovpmfl*|*kevgrhcjxspbxgovpmfl.supabase.co*)
    echo "error: refusing production project kevgrhcjxspbxgovpmfl" >&2
    exit 3
    ;;
esac
command -v psql >/dev/null 2>&1 || {
  echo "error: psql is required" >&2
  exit 2
}

MIGRATION="$ROOT/supabase/migrations/20260720000001_makesafe_intake_cases.sql"
CONTRACT="$ROOT/supabase/tests/makesafe_intake_cases_contract.sql"

# The second apply proves migration re-apply safety on the clone.
psql "$URL" -X -v ON_ERROR_STOP=1 -f "$MIGRATION"
psql "$URL" -X -v ON_ERROR_STOP=1 -f "$MIGRATION"
psql "$URL" -X -v ON_ERROR_STOP=1 -f "$CONTRACT"

echo "make-safe intake case migration clone contract passed"
