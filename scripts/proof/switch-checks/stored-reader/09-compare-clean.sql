-- Stored reader, check 9, on the ZZTEST job: the stored rows match the live
-- Job Profit views, by the same rules as job_profit_stored_compare: every
-- view column is stored, each shared column holds the same value, and the
-- stored cost and revenue events match the views' in count and sum. Scoped
-- to the one job and a plain read: job_profit_stored_compare itself creates
-- a temporary table (refused in a read-only session) and reads every job.
-- Evidence carries counts and column names only, never an amount.
\set zz_check 'stored_reader.compare_clean'
\ir ../session.sql
\if :zz_ok
WITH s AS (SELECT to_jsonb(p) AS j FROM public.job_profit_stored p WHERE p.job_id = :'zz_job_id'),
v AS (SELECT to_jsonb(q) AS j FROM public.v_job_profit q WHERE q.job_id = :'zz_job_id'),
stored_cols AS (
  SELECT column_name::text AS c FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'job_profit_stored'
), missing_cols AS (
  SELECT a.column_name::text AS c FROM information_schema.columns a
  WHERE a.table_schema = 'public' AND a.table_name = 'v_job_profit'
    AND a.column_name::text NOT IN (SELECT c FROM stored_cols)
), diff AS (
  SELECT d.key FROM v CROSS JOIN LATERAL jsonb_each(v.j) d LEFT JOIN s ON true
  WHERE d.key IN (SELECT c FROM stored_cols) AND d.value IS DISTINCT FROM s.j -> d.key
), ev AS (
  SELECT 'cost_events' AS lane,
         (SELECT count(*) FROM public.v_job_cost_events WHERE job_id = :'zz_job_id') AS view_n,
         (SELECT count(*) FROM public.job_cost_events_stored WHERE job_id = :'zz_job_id') AS stored_n,
         (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE job_id = :'zz_job_id')
           IS NOT DISTINCT FROM (SELECT sum(amount_ex) FROM public.job_cost_events_stored WHERE job_id = :'zz_job_id') AS sums_equal
  UNION ALL
  SELECT 'revenue_events',
         (SELECT count(*) FROM public.v_job_revenue_events WHERE job_id = :'zz_job_id'),
         (SELECT count(*) FROM public.job_revenue_events_stored WHERE job_id = :'zz_job_id'),
         (SELECT sum(amount_ex) FROM public.v_job_revenue_events WHERE job_id = :'zz_job_id')
           IS NOT DISTINCT FROM (SELECT sum(amount_ex) FROM public.job_revenue_events_stored WHERE job_id = :'zz_job_id')
)
SELECT :'zz_check' AS "check",
       CASE WHEN EXISTS (SELECT 1 FROM s) AND EXISTS (SELECT 1 FROM v)
             AND NOT EXISTS (SELECT 1 FROM missing_cols) AND NOT EXISTS (SELECT 1 FROM diff)
             AND NOT EXISTS (SELECT 1 FROM ev WHERE view_n <> stored_n OR NOT sums_equal) THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('stored_row', EXISTS (SELECT 1 FROM s), 'view_row', EXISTS (SELECT 1 FROM v),
                          'missing_columns', (SELECT coalesce(jsonb_agg(c ORDER BY c), '[]') FROM missing_cols),
                          'differing_columns', (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]') FROM diff),
                          'events', (SELECT jsonb_object_agg(lane, jsonb_build_object('view', view_n, 'stored', stored_n,
                                       'sums_equal', sums_equal)) FROM ev))::text AS evidence;
\endif
