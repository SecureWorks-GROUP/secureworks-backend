#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

CONTRACT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "$CONTRACT_ROOT/../../.." && pwd -P)
ADMIN_DATABASE_URL=${MIGRATION_CONTRACT_ADMIN_DATABASE_URL:-}
DISPOSABLE_ACK=${MIGRATION_CONTRACT_DISPOSABLE_ACK:-}
CONTRACT_DATABASE=secureworks_migration_contracts
# The full registered stack before any contract runs, kept as the template the
# break proofs copy.
STACK_DATABASE=${CONTRACT_DATABASE}_stack
# The copy one fail-closed, rollback or break proof runs in.
PROOF_DATABASE=${CONTRACT_DATABASE}_proof
CONTRACT_DATABASE_URL=

# No statement may wait forever: a stuck statement fails with its own error and
# the label printed above it, long before the job's own time limit. A contract
# that needs less still sets its own SET LOCAL statement_timeout.
STATEMENT_TIMEOUT=${MIGRATION_CONTRACT_STATEMENT_TIMEOUT:-15min}
export PGOPTIONS="${PGOPTIONS:-} -c statement_timeout=$STATEMENT_TIMEOUT"

if [ "$DISPOSABLE_ACK" != "I-confirm-this-is-disposable-local-postgres" ]; then
  echo "error: set MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres" >&2
  exit 2
fi

case "$ADMIN_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*)
    ;;
  *)
    echo "error: MIGRATION_CONTRACT_ADMIN_DATABASE_URL must target localhost" >&2
    exit 2
    ;;
esac

command -v psql >/dev/null 2>&1 || {
  echo "error: psql is required" >&2
  exit 2
}

case_directories=("$CONTRACT_ROOT"/20*)
if [ ! -d "${case_directories[0]}" ]; then
  echo "error: no migration contract cases found under $CONTRACT_ROOT" >&2
  exit 2
fi

for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  migration="$REPO_ROOT/supabase/migrations/$case_name.sql"
  for required_file in "$case_directory/setup.sql" "$case_directory/contract.sql" "$migration"; do
    if [ ! -f "$required_file" ]; then
      echo "error: missing migration contract file $required_file" >&2
      exit 2
    fi
  done
  if [ -f "$case_directory/rollback-contract.sql" ] \
    && [ ! -f "$REPO_ROOT/supabase/rollbacks/${case_name}_down.sql" ]; then
    echo "error: missing rollback for $case_directory/rollback-contract.sql" >&2
    exit 2
  fi
done

database_url() {
  printf '%s/%s' "${ADMIN_DATABASE_URL%/*}" "$1"
}

drop_database() {
  psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "SET client_min_messages = warning" \
    -c "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE);" >/dev/null
}

reset_contract_database() {
  drop_database "$CONTRACT_DATABASE"
  psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$CONTRACT_DATABASE\";" >/dev/null
  CONTRACT_DATABASE_URL=$(database_url "$CONTRACT_DATABASE")
}

# A proof starts from a byte-for-byte copy of a database the runner already
# built, never from a fresh replay of the registered stack. Every
# fail-closed, rollback and break proof used to replay all registered
# migrations from an empty database, so the job grew with the square of the
# case count: on 16 Oct 2026, 144 cases and about 320 replays took 35 to 80
# minutes, and the slower runners hit the 90 minute job limit. A copy holds
# exactly the schema and rows the replay produced, and roles are cluster wide,
# so each proof still sees what it saw before.
copy_database_to_proof() {
  local source=$1
  drop_database "$PROOF_DATABASE"
  psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$PROOF_DATABASE\" TEMPLATE \"$source\";" >/dev/null
  CONTRACT_DATABASE_URL=$(database_url "$PROOF_DATABASE")
}

drop_proof_database() {
  drop_database "$PROOF_DATABASE"
  CONTRACT_DATABASE_URL=$(database_url "$CONTRACT_DATABASE")
}

cleanup() {
  drop_database "$PROOF_DATABASE" || true
  drop_database "$STACK_DATABASE" || true
  drop_database "$CONTRACT_DATABASE" || true
}
trap cleanup EXIT

run_sql_file() {
  local label=$1
  local sql_file=$2
  echo "== $label =="
  psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$sql_file"
}

run_concurrent_case() {
  local case_directory=$1
  local concurrent_script="$case_directory/concurrent.sh"
  if [ ! -f "$concurrent_script" ]; then
    return
  fi
  echo "== $(basename "$case_directory") concurrent sessions =="
  CONTRACT_DATABASE_URL="$CONTRACT_DATABASE_URL" \
    bash "$concurrent_script"
}

expect_sql_file_failure() {
  local label=$1
  local sql_file=$2
  local expected_file=$3
  local output
  local status
  local expected

  echo "== $label (expected failure) =="
  set +e
  output=$(psql "$CONTRACT_DATABASE_URL" -X \
    -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f "$sql_file" 2>&1)
  status=$?
  set -e
  printf '%s\n' "$output"

  if [ "$status" -eq 0 ]; then
    echo "error: expected $sql_file to fail" >&2
    exit 1
  fi
  while IFS= read -r expected || [ -n "$expected" ]; do
    [ -z "$expected" ] && continue
    if ! grep -Fq -- "$expected" <<< "$output"; then
      echo "error: failure did not contain expected text: $expected" >&2
      exit 1
    fi
  done < "$expected_file"
}

# Prove migrations fail closed when their documented pre-existing invalid state
# exists. One forward walk applies the registered stack; at each such case the
# walk stops immediately before the migration under test, and the proof runs
# in a copy of that state.
reset_contract_database
for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  run_sql_file "$case_name prerequisites" "$case_directory/setup.sql"
  if [ -f "$case_directory/preexisting-failure.sql" ]; then
    if [ ! -f "$case_directory/preexisting-failure.expected" ]; then
      echo "error: missing $case_directory/preexisting-failure.expected" >&2
      exit 2
    fi
    copy_database_to_proof "$CONTRACT_DATABASE"
    run_sql_file "$case_name pre-existing invalid state" "$case_directory/preexisting-failure.sql"
    expect_sql_file_failure \
      "$case_name fail-closed migration" \
      "$REPO_ROOT/supabase/migrations/$case_name.sql" \
      "$case_directory/preexisting-failure.expected"
    drop_proof_database
  fi
  run_sql_file "$case_name migration" "$REPO_ROOT/supabase/migrations/$case_name.sql"
done

# The walk now holds every registered migration in timestamp order. Keep a copy
# for the break proofs, then execute each SQL behaviour contract against the
# resulting real PostgreSQL schema.
drop_database "$STACK_DATABASE"
psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$STACK_DATABASE\" TEMPLATE \"$CONTRACT_DATABASE\";" >/dev/null
for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  run_sql_file "$case_name contract" "$case_directory/contract.sql"
  run_concurrent_case "$case_directory"
done

# Prove an optional down migration executes cleanly against the exact forward
# stack it reverses, then assert the promised legacy surface is restored. A
# second fresh walk applies the stack; after each such case's migration the
# down migration runs in a copy of the stack through that case.
reset_contract_database
for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  run_sql_file "$case_name prerequisites" "$case_directory/setup.sql"
  run_sql_file "$case_name migration" "$REPO_ROOT/supabase/migrations/$case_name.sql"
  if [ -f "$case_directory/rollback-contract.sql" ]; then
    copy_database_to_proof "$CONTRACT_DATABASE"
    run_sql_file \
      "$case_name rollback" \
      "$REPO_ROOT/supabase/rollbacks/${case_name}_down.sql"
    run_sql_file "$case_name rollback contract" "$case_directory/rollback-contract.sql"
    drop_proof_database
  fi
done

# Meta-test the contract itself. Deliberately remove the constraint, then prove
# the contract fails for the expected reason. A migration that omitted the same
# constraint would therefore fail the positive contract phase above. Each break
# starts from a copy of the full stack as it stood before any contract ran.
for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  if [ -f "$case_directory/break-contract.sql" ]; then
    if [ ! -f "$case_directory/break-contract.expected" ]; then
      echo "error: missing $case_directory/break-contract.expected" >&2
      exit 2
    fi
    copy_database_to_proof "$STACK_DATABASE"
    run_sql_file "$case_name deliberate constraint break" "$case_directory/break-contract.sql"
    expect_sql_file_failure \
      "$case_name broken-constraint contract" \
      "$case_directory/contract.sql" \
      "$case_directory/break-contract.expected"
    drop_proof_database
  fi
done

echo "PostgreSQL migration contracts passed"
