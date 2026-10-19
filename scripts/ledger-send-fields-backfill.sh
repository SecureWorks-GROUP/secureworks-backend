#!/usr/bin/env bash
# Count existing typed send and invoice-money values. Read only.
# Refuses --apply. Refuses any database that is not on localhost.
# Production was not a target of this script.
set -euo pipefail

if [ "${1:-}" = "--apply" ] || [ "${LEDGER_SEND_FIELDS_APPLY:-}" = "1" ]; then
  echo "error: this script does not write. Remove --apply." >&2
  exit 2
fi

DATABASE_URL=${LEDGER_SEND_FIELDS_DATABASE_URL:-${1:-}}
case "$DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*)
    ;;
  *)
    echo "error: LEDGER_SEND_FIELDS_DATABASE_URL must target localhost" >&2
    exit 2
    ;;
esac

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$ROOT/scripts/ledger-send-fields-backfill.sql"
