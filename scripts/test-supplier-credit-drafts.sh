#!/usr/bin/env bash
set -euo pipefail
# This script creates and stops only its own disposable local Postgres cluster.
REPO_ROOT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
SCRATCH_ROOT=${SUPPLIER_CREDIT_TEST_SCRATCH:-/Volumes/SSD/agent-scratch/cx-p3-02-12}
case "$SCRATCH_ROOT" in /Volumes/SSD/agent-scratch/*) ;; *) echo 'scratch must be on SSD' >&2; exit 2;; esac
mkdir -p "$SCRATCH_ROOT"
CASE_ROOT=$(mktemp -d "$SCRATCH_ROOT/credit-contract.XXXXXX")
PG_BIN=$(dirname "$(command -v initdb)")
cleanup() { "$PG_BIN/pg_ctl" -D "$CASE_ROOT/pgdata" -m immediate stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$CASE_ROOT/pgdata" -A trust -U postgres >"$CASE_ROOT/initdb.log"
# Unix socket only, no shared database or listener.
"$PG_BIN/pg_ctl" -D "$CASE_ROOT/pgdata" -l "$CASE_ROOT/postgres.log" \
  -o "-c listen_addresses='' -k $CASE_ROOT -p 55492" -w start >/dev/null
PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$CASE_ROOT" -p 55492 -U postgres -d postgres)
CASE_NAME=20261118044001_supplier_credit_drafts
"${PSQL[@]}" -f "$REPO_ROOT/supabase/tests/migration-contracts/$CASE_NAME/setup.sql"
"${PSQL[@]}" -f "$REPO_ROOT/supabase/migrations/$CASE_NAME.sql"
"${PSQL[@]}" -f "$REPO_ROOT/supabase/migrations/$CASE_NAME.sql"
"${PSQL[@]}" -f "$REPO_ROOT/supabase/tests/supplier_credit_drafts_contract.sql"
"${PSQL[@]}" -f "$REPO_ROOT/supabase/tests/migration-contracts/$CASE_NAME/rollback-contract.sql"
echo 'PASS supplier credit drafts: applied twice; own contract and rolled-back rollback passed'
