#!/usr/bin/env bash
# Narrow runner test: four invented migrations, never the repository's stack.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
: "${CI_PARITY_TEST_SCRATCH:?Set a fresh directory below the task SSD folder}"
case "$CI_PARITY_TEST_SCRATCH" in
  /Volumes/SSD/agent-scratch/cx-ci-parity/*|/Volumes/SSD/agent-scratch/cx-1559-shard/*|"${RUNNER_TEMP:-/unset-runner-temp}"/*) ;;
  *) echo 'error: scratch must be in the task SSD folder or RUNNER_TEMP' >&2; exit 2 ;;
esac
mkdir "$CI_PARITY_TEST_SCRATCH"
TEST_ROOT="$CI_PARITY_TEST_SCRATCH/repo"
CASES="$TEST_ROOT/supabase/tests/migration-contracts"
mkdir -p "$CASES" "$TEST_ROOT/supabase/migrations" "$TEST_ROOT/scripts"
cp "$ROOT/supabase/tests/migration-contracts/run.sh" "$CASES/run.sh"
cp "$ROOT/scripts/compare-public-object-md5.ts" "$TEST_ROOT/scripts/"
for name in 20260101000000_fixture_base 20260101000003_fixture_witness; do
  mkdir "$CASES/$name"
  printf 'SELECT 1;\n' > "$CASES/$name/setup.sql"
  printf 'SELECT 1;\n' > "$CASES/$name/contract.sql"
done
cat > "$TEST_ROOT/supabase/migrations/20260101000000_fixture_base.sql" <<'SQL'
CREATE FUNCTION public.job_profit() RETURNS integer LANGUAGE sql AS 'SELECT 1';
CREATE FUNCTION public.context_fixture() RETURNS integer LANGUAGE sql AS 'SELECT 1';
CREATE FUNCTION public.group_work_order_fixture() RETURNS integer LANGUAGE sql AS 'SELECT 1';
SQL
cat > "$TEST_ROOT/supabase/migrations/20260101000001_fixture_good.sql" <<'SQL'
CREATE TABLE public.supplemental_kept (value integer);
CREATE OR REPLACE FUNCTION public.job_profit() RETURNS integer LANGUAGE sql AS 'SELECT 2';
SQL
cat > "$TEST_ROOT/supabase/migrations/20260101000002_fixture_refused.sql" <<'SQL'
CREATE TABLE public.must_not_leak (value integer);
DO $$ BEGIN RAISE EXCEPTION 'fixture refusal'; END $$;
SQL
printf 'SELECT 1;\n' > "$TEST_ROOT/supabase/migrations/20260101000003_fixture_witness.sql"
cat > "$CASES/supplemental-migrations.txt" <<'LIST'
20260101000001_fixture_good
20260101000002_fixture_refused
LIST
cat > "$CASES/20260101000003_fixture_witness/contract.sql" <<'SQL'
DO $$ BEGIN
  IF to_regclass('public.supplemental_kept') IS NOT NULL OR public.job_profit() <> 1 THEN
    RAISE EXCEPTION 'default contracts inherited supplemental effects';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.job_profit() RETURNS integer LANGUAGE sql AS 'SELECT 3';
SQL
export MIGRATION_CONTRACT_CATALOG_OUTPUT="$CI_PARITY_TEST_SCRATCH/default.tsv"
export MIGRATION_CONTRACT_SUPPLEMENTAL_OUTPUT="$CI_PARITY_TEST_SCRATCH/default-inventory.tsv"
# Default mode must ignore the supplemental registry in BOTH walks.
unset MIGRATION_CONTRACT_MODE
bash "$CASES/run.sh" > "$CI_PARITY_TEST_SCRATCH/default.log" 2>&1
[ ! -s "$MIGRATION_CONTRACT_SUPPLEMENTAL_OUTPUT" ]
grep -Fqx "$(printf 'function\tjob_profit()\tb1698e52a0f16203489454196a0c6307')" "$MIGRATION_CONTRACT_CATALOG_OUTPUT"
grep -Fq 'PostgreSQL migration contracts passed' "$CI_PARITY_TEST_SCRATCH/default.log"
# Parity never runs contract assertions. Check partial DDL in the later
# registered migration instead, then deliberately make the contract fail.
cat > "$TEST_ROOT/supabase/migrations/20260101000003_fixture_witness.sql" <<'SQL'
DO $$ BEGIN
  IF to_regclass('public.must_not_leak') IS NOT NULL THEN RAISE EXCEPTION 'partial DDL leaked'; END IF;
  IF to_regclass('public.supplemental_kept') IS NULL OR public.job_profit() <> 2 THEN
    RAISE EXCEPTION 'supplemental step was not applied in number order';
  END IF;
END $$;
SQL
printf 'SELECT public.contract_must_not_run();\n' > "$CASES/20260101000003_fixture_witness/contract.sql"
export MIGRATION_CONTRACT_MODE=parity
export MIGRATION_CONTRACT_CATALOG_OUTPUT="$CI_PARITY_TEST_SCRATCH/fresh.tsv"
export MIGRATION_CONTRACT_SUPPLEMENTAL_OUTPUT="$CI_PARITY_TEST_SCRATCH/inventory.tsv"
bash "$CASES/run.sh" > "$CI_PARITY_TEST_SCRATCH/walk.log" 2>&1
grep -Fqx "$(printf 'forward\t20260101000001_fixture_good\tapplied\t00000')" "$MIGRATION_CONTRACT_SUPPLEMENTAL_OUTPUT"
grep -Fqx "$(printf 'forward\t20260101000002_fixture_refused\trefused\tP0001')" "$MIGRATION_CONTRACT_SUPPLEMENTAL_OUTPUT"
[ "$(wc -l < "$MIGRATION_CONTRACT_SUPPLEMENTAL_OUTPUT" | tr -d ' ')" -eq 2 ]
grep -Fq 'PostgreSQL parity catalog exported' "$CI_PARITY_TEST_SCRATCH/walk.log"
EXPECTED=fc1c7a0bdce312b20bc3780dd6d41aaa
grep -Fqx "$(printf 'function\tjob_profit()\t%s' "$EXPECTED")" "$MIGRATION_CONTRACT_CATALOG_OUTPUT"
# A registered migration failure must stop, never enter the refusal inventory.
printf 'SELECT public.fixture_missing_function();\n' > "$TEST_ROOT/supabase/migrations/20260101000003_fixture_witness.sql"
if bash "$CASES/run.sh" > "$CI_PARITY_TEST_SCRATCH/registered-failure.log" 2>&1; then
  echo 'error: registered migration failure was swallowed' >&2
  exit 1
fi
grep -Fq 'fixture_missing_function' "$CI_PARITY_TEST_SCRATCH/registered-failure.log"
echo 'CI migration walk: 8 checks passed (default isolation in both walks, ordering, success, atomic refusal, forward-only parity, skipped assertions, pre-contract export, registered error)'
