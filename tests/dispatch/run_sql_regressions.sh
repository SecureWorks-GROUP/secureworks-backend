#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
EXPECTED_PGHOST="127.0.0.1"
EXPECTED_PGPORT="55581"
EXPECTED_PGDATABASE="dispatch_test5"
if [[ "${PGHOST:-${EXPECTED_PGHOST}}" != "${EXPECTED_PGHOST}" || "${PGPORT:-${EXPECTED_PGPORT}}" != "${EXPECTED_PGPORT}" || "${PGDATABASE:-${EXPECTED_PGDATABASE}}" != "${EXPECTED_PGDATABASE}" ]]; then
  echo "dispatch SQL regressions require ${EXPECTED_PGHOST}:${EXPECTED_PGPORT}/${EXPECTED_PGDATABASE}" >&2
  exit 2
fi
PGHOST="${EXPECTED_PGHOST}"
PGPORT="${EXPECTED_PGPORT}"
PGDATABASE="${EXPECTED_PGDATABASE}"
HELD_SCHEMA="public_dispatch_sql_$$_${RANDOM}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"${PSQL_BIN}" -h "${PGHOST}" -p "${PGPORT}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -v APPLY_LUNA=1 \
  -v held_schema="${HELD_SCHEMA}" \
  -c "begin" \
  -c "set local lock_timeout = '5s'" \
  -c "do \$\$ begin if current_database() <> 'dispatch_test5' then raise exception 'dispatch_test5 required'; end if; if not exists(select 1 from pg_roles where rolname='anon') or not exists(select 1 from pg_roles where rolname='authenticated') or not exists(select 1 from pg_roles where rolname='service_role') then raise exception 'required Supabase roles missing'; end if; end \$\$" \
  -c "alter schema public rename to \"${HELD_SCHEMA}\"" \
  -c "create schema public" \
  -c "grant usage on schema public to anon, authenticated, service_role" \
  -f "${ROOT_DIR}/tests/dispatch/fixture.sql" \
  -f "${ROOT_DIR}/supabase/migrations/20260910112833_luna_context_source_revisions.sql" \
  -f "${ROOT_DIR}/supabase/migrations/20260912150402_dispatch_workbench.sql" \
  -f "${ROOT_DIR}/tests/dispatch/persistence.sql" \
  -f "${ROOT_DIR}/tests/dispatch/workflow.sql" \
  -f "${ROOT_DIR}/tests/dispatch/review_regressions.sql" \
  -f "${ROOT_DIR}/tests/dispatch/lineage_queue.sql" \
  -f "${ROOT_DIR}/tests/dispatch/strict_lineage.sql" \
  -f "${ROOT_DIR}/tests/dispatch/task_recovery.sql" \
  -f "${ROOT_DIR}/tests/dispatch/execution_recovery.sql" \
  -c "rollback"
