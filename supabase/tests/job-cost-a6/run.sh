#!/usr/bin/env bash
# Job Profit A6 cost rules (20261104070000, 20261104071000, 20261104072000) on the production surface of
# v_job_cost_events alone (setup.sql: production's column types, helpers and views as read on 3 Nov 2026), on a
# disposable local PostgreSQL 17. A quick run of the registered cases' own files without the whole stack:
# the refusal, each migration's md5, the re-run no-op, the three contracts, each rollback and its contract,
# the three break proofs, and a clean re-apply. CI runs the same case files in supabase/tests/migration-contracts.
#
#   JOB_COST_A6_DATABASE_URL='postgresql://postgres@127.0.0.1:55433/postgres' \
#   JOB_COST_A6_DISPOSABLE_ACK='I-confirm-this-is-disposable-local-postgres' \
#   bash supabase/tests/job-cost-a6/run.sh
set -euo pipefail
export LC_ALL=C
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$HERE/../../.." && pwd -P)
ADMIN=${JOB_COST_A6_DATABASE_URL:-}
[ "${JOB_COST_A6_DISPOSABLE_ACK:-}" = "I-confirm-this-is-disposable-local-postgres" ] || { echo "error: set JOB_COST_A6_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres" >&2; exit 2; }
case "$ADMIN" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;
  *) echo "error: JOB_COST_A6_DATABASE_URL must target localhost" >&2; exit 2 ;;
esac
DB=job_cost_a6_contract
URL="${ADMIN%/*}/$DB"
M="$REPO/supabase/migrations"; RB="$REPO/supabase/rollbacks"; MC="$REPO/supabase/tests/migration-contracts"
MIGS=(20261104070000_job_cost_follows_ledger_split_lines 20261104071000_job_cost_xero_crew_bill_super 20261104072000_job_cost_credit_at_note_ex_gst)
MD5=(33d1c54d5a288fe496b5b863a1ec1d4c 32c422a8d90aecf6924fc0a84d4569fe cd749fcbe09bedde4a277f6da3ade6fd 366599ce55b0e0430d45ee9e6e04c315)
q() { psql "$URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
md5() { q -Atc "select md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))"; }
want() { local got; got=$(md5); [ "$got" = "$1" ] || { echo "FAIL: $2: md5 $got, want $1" >&2; exit 1; }; echo "ok: $2"; }
fresh() {
  psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" >/dev/null 2>&1
  q -f "$HERE/setup.sql" >/dev/null
}
forward() { for i in 0 1 2; do q -1 -f "$M/${MIGS[$i]}.sql" >/dev/null; done; }
contracts() { for m in "${MIGS[@]}"; do echo "contract ${m:0:14}: $(q -At -f "$MC/$m/contract.sql")"; done; }
trap 'psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true' EXIT

# Refusal: a definition other than the one 20261104070000 was written against is never overwritten.
fresh
q -c "DO \$\$ DECLARE d text := pg_get_viewdef('public.v_job_cost_events'::regclass, true); BEGIN EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || replace(d, '''unclassified''::text THEN ''other''::text', '''unclassified''::text THEN ''materials''::text'); END \$\$;" >/dev/null
if out=$(q -1 -f "$M/${MIGS[0]}.sql" 2>&1); then echo "FAIL: 20261104070000 applied over another definition" >&2; exit 1; fi
grep -qF "$(cat "$MC/${MIGS[0]}/preexisting-failure.expected")" <<< "$out" || { echo "FAIL: refusal text: $out" >&2; exit 1; }
echo "ok: 20261104070000 refuses a definition it was not written against"

fresh
want "${MD5[0]}" "setup prints production's 20261104063000 (A4 V8) definition"
for i in 0 1 2; do q -1 -f "$M/${MIGS[$i]}.sql" >/dev/null; want "${MD5[$((i + 1))]}" "${MIGS[$i]} applied"; done
for i in 0 1 2; do q -1 -f "$M/${MIGS[$i]}.sql" >/dev/null 2>&1; want "${MD5[3]}" "${MIGS[$i]} re-run is a no-op"; done
contracts
for i in 2 1 0; do
  q -1 -f "$RB/${MIGS[$i]}_down.sql" >/dev/null 2>&1
  q -f "$MC/${MIGS[$i]}/rollback-contract.sql" >/dev/null
  want "${MD5[$i]}" "${MIGS[$i]} rolled back (rollback contract passed)"
  q -1 -f "$RB/${MIGS[$i]}_down.sql" >/dev/null 2>&1
  want "${MD5[$i]}" "${MIGS[$i]} rollback re-run is a no-op"
done
forward; q -1 -f "$M/${MIGS[0]}.sql" >/dev/null 2>&1
if q -1 -f "$RB/${MIGS[0]}_down.sql" >/dev/null 2>&1; then echo "FAIL: 20261104070000 rollback ran under a later change of the set" >&2; exit 1; fi
echo "ok: a rollback refuses while a later change of the set is in"

# Break proofs: the case's contract fails, for its named reason, once its rule is taken away.
for m in "${MIGS[@]}"; do
  fresh; forward
  (cd "$MC/$m" && q -f break-contract.sql >/dev/null 2>&1)
  if out=$(q -At -f "$MC/$m/contract.sql" 2>&1); then echo "FAIL: ${m:0:14} contract passed after its break" >&2; exit 1; fi
  grep -qF "$(cat "$MC/$m/break-contract.expected")" <<< "$out" || { echo "FAIL: ${m:0:14} break failed for another reason: $out" >&2; exit 1; }
  echo "ok: ${m:0:14} contract catches its rule taken away"
done

fresh; forward
want "${MD5[3]}" "re-applied on a fresh surface"
contracts
echo "job-cost-a6: all passed"
