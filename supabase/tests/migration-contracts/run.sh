#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

CONTRACT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "$CONTRACT_ROOT/../../.." && pwd -P)
ADMIN_DATABASE_URL=${MIGRATION_CONTRACT_ADMIN_DATABASE_URL:-}
DISPOSABLE_ACK=${MIGRATION_CONTRACT_DISPOSABLE_ACK:-}
CONTRACT_DATABASE=secureworks_migration_contracts
CONTRACT_DATABASE_URL=

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

drop_contract_database() {
  psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$CONTRACT_DATABASE\" WITH (FORCE);" >/dev/null
}

reset_contract_database() {
  drop_contract_database
  psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$CONTRACT_DATABASE\";" >/dev/null
  CONTRACT_DATABASE_URL="${ADMIN_DATABASE_URL%/*}/$CONTRACT_DATABASE"
}

cleanup() {
  drop_contract_database || true
}
trap cleanup EXIT

run_sql_file() {
  local label=$1
  local sql_file=$2
  echo "== $label =="
  psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$sql_file"
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

apply_registered_stack() {
  local stop_before=${1:-}
  local case_directory
  local case_name

  for case_directory in "${case_directories[@]}"; do
    case_name=$(basename "$case_directory")
    run_sql_file "$case_name prerequisites" "$case_directory/setup.sql"
    if [ "$case_name" = "$stop_before" ]; then
      return
    fi
    run_sql_file "$case_name migration" "$REPO_ROOT/supabase/migrations/$case_name.sql"
  done
}

apply_registered_stack_through() {
  local stop_after=$1
  local case_directory
  local case_name

  for case_directory in "${case_directories[@]}"; do
    case_name=$(basename "$case_directory")
    run_sql_file "$case_name prerequisites" "$case_directory/setup.sql"
    run_sql_file "$case_name migration" "$REPO_ROOT/supabase/migrations/$case_name.sql"
    if [ "$case_name" = "$stop_after" ]; then
      return
    fi
  done
  echo "error: rollback contract case not registered: $stop_after" >&2
  exit 2
}

# Prove migrations fail closed when their documented pre-existing invalid state
# exists. Each proof starts from a fresh database and stops immediately before
# the migration under test.
for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  if [ -f "$case_directory/preexisting-failure.sql" ]; then
    if [ ! -f "$case_directory/preexisting-failure.expected" ]; then
      echo "error: missing $case_directory/preexisting-failure.expected" >&2
      exit 2
    fi
    reset_contract_database
    apply_registered_stack "$case_name"
    run_sql_file "$case_name pre-existing invalid state" "$case_directory/preexisting-failure.sql"
    expect_sql_file_failure \
      "$case_name fail-closed migration" \
      "$REPO_ROOT/supabase/migrations/$case_name.sql" \
      "$case_directory/preexisting-failure.expected"
  fi
done

# Apply every registered migration in timestamp order, then execute its SQL
# behaviour contract against the resulting real PostgreSQL schema.
reset_contract_database
apply_registered_stack
for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  run_sql_file "$case_name contract" "$case_directory/contract.sql"
done

# Prove an optional down migration executes cleanly against the exact forward
# stack it reverses, then assert the promised legacy surface is restored.
for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  if [ -f "$case_directory/rollback-contract.sql" ]; then
    reset_contract_database
    apply_registered_stack_through "$case_name"
    run_sql_file \
      "$case_name rollback" \
      "$REPO_ROOT/supabase/rollbacks/${case_name}_down.sql"
    run_sql_file "$case_name rollback contract" "$case_directory/rollback-contract.sql"
  fi
done

# Meta-test the contract itself. Deliberately remove the constraint, then prove
# the contract fails for the expected reason. A migration that omitted the same
# constraint would therefore fail the positive contract phase above.
for case_directory in "${case_directories[@]}"; do
  case_name=$(basename "$case_directory")
  if [ -f "$case_directory/break-contract.sql" ]; then
    if [ ! -f "$case_directory/break-contract.expected" ]; then
      echo "error: missing $case_directory/break-contract.expected" >&2
      exit 2
    fi
    reset_contract_database
    apply_registered_stack
    run_sql_file "$case_name deliberate constraint break" "$case_directory/break-contract.sql"
    expect_sql_file_failure \
      "$case_name broken-constraint contract" \
      "$case_directory/contract.sql" \
      "$case_directory/break-contract.expected"
  fi
done

echo "PostgreSQL migration contracts passed"
