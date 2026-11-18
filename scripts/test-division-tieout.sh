#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
cluster=$(mktemp -d "${TMPDIR:-/tmp}/division-tieout.XXXXXX")
cleanup() {
  if [[ -f "$cluster/data/postmaster.pid" ]]; then
    pg_ctl -D "$cluster/data" -m immediate -w stop >/dev/null || return 1
  fi
  rm -rf -- "$cluster"
}
trap cleanup EXIT

# Private Unix socket only. An existing database is never a target.
initdb -D "$cluster/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
pg_ctl -D "$cluster/data" -l "$cluster/postgres.log" \
  -o "-c listen_addresses='' -k '$cluster'" -w start >/dev/null
psql -X -h "$cluster" -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f "$repo_root/supabase/tests/division_tieout_contract.sql"
