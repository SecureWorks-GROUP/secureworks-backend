#!/usr/bin/env bash
# Point DIVISION_TWIN_TEST_DATABASE_URL at disposable local Postgres with the
# three Supabase roles. Both applications and the rollback are transaction-local.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)
url=${DIVISION_TWIN_TEST_DATABASE_URL:-}
local_url='^postgres(ql)?://([A-Za-z0-9_]+@)?(localhost|127\.0\.0\.1):[0-9]+/[A-Za-z0-9_]+$'
if ! [[ "$url" =~ $local_url ]]; then
  echo 'Set DIVISION_TWIN_TEST_DATABASE_URL to a local PostgreSQL URL with an explicit port and database.' >&2
  exit 2
fi
# Pin the network address as well as the URI host. Ignore inherited service routing.
unset PGSERVICE PGSERVICEFILE
export PGHOSTADDR=127.0.0.1

examples=$(jq -ce 'select(type == "array" and length > 0 and all(.[];
  has("job_number") and has("job_type") and (.expect | type == "string")))' \
  "$root/supabase/functions/_shared/division_examples.json")
migration=("$root"/supabase/migrations/*_job_division_option.sql)
[[ ${#migration[@]} == 1 && -f "${migration[0]}" ]] || { echo 'Expected one division migration' >&2; exit 2; }
name=$(basename "${migration[0]}" .sql)

results=$(psql -XqAtw "$url" -v ON_ERROR_STOP=1 -v examples="$examples" \
  -v migration="${migration[0]}" -v down="$root/supabase/rollbacks/${name}_down.sql" <<'SQL'
BEGIN;
\i :migration
\i :migration
WITH jobs AS (
  SELECT job_number, job_type, expect, public.job_division_option(job_number, job_type) AS actual
  FROM jsonb_to_recordset(:'examples'::jsonb) AS e(job_number text, job_type text, expect text)
), stock AS (
  SELECT division, expect, public.stock_division_option(division) AS actual
  FROM (VALUES ('patios','SW - PATIOS'), ('fencing','SW - FENCING'), ('insurance','SW - INSURANCE WORK'),
               ('decking',''), ('',''), (NULL,'')) AS e(division, expect)
)
SELECT json_build_object('jobs', (SELECT count(*) FROM jobs), 'stock', (SELECT count(*) FROM stock),
  'mismatches', ARRAY(
    SELECT to_jsonb(jobs) FROM jobs WHERE actual IS DISTINCT FROM expect
    UNION ALL
    SELECT to_jsonb(stock) FROM stock WHERE actual IS DISTINCT FROM expect
  ));
\i :down
SELECT to_regprocedure('public.job_division_option(text,text)') IS NULL
   AND to_regprocedure('public.stock_division_option(text)') IS NULL;
ROLLBACK;
SQL
)
report=${results%$'\n'*}
jq -c '.mismatches[]' <<<"$report"
jq -r '"\(.jobs) job examples, \(.stock) stock examples, \(.mismatches | length) mismatches"' <<<"$report"
[[ "${results##*$'\n'}" == t ]] || { echo 'Rollback left a division function installed' >&2; exit 1; }
jq -e '.mismatches | length == 0' <<<"$report" >/dev/null

# Both the SQL and the TypeScript mapper must agree with the same examples.
deno test --no-check --allow-env --allow-read --filter 'division examples:' \
  "$root/supabase/functions/_shared/xero_draft_standard_test.ts"
