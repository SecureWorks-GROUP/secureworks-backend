-- P2-01.8 (F2): the cost-lines cutover preconditions, read only.
-- Runs public.job_cost_events_cutover_check for one organisation and prints its
-- answer. Writes nothing and turns no switch: the stamps are written only by
-- public.job_cost_events_cutover_complete, which the database owner runs by hand.
--
--   psql "$DATABASE_URL" -X -v org_id=<org uuid> [-v cutoff=YYYY-MM-DD] -f scripts/proof/cost-cutover-check.sql
--
-- cutoff defaults to 2026-10-01 (the owner's cut-off date). The answer carries
-- counts, booleans and, under profit_diffs.jobs, at most 50 job ids with their
-- legacy and cost-line totals; no names. Read only, capped at 130 seconds.
\if :{?cutoff}
\else
\set cutoff 2026-10-01
\endif
BEGIN READ ONLY;
SET LOCAL statement_timeout = '130s';
SELECT jsonb_pretty(public.job_cost_events_cutover_check(:'org_id'::uuid, :'cutoff'::date)) AS cutover_check;
ROLLBACK;
