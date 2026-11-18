-- Stored reader, check 11, on the ZZTEST job: after the next refresh.
-- Needs psql variable changed_at: when the director made the ZZTEST change
-- (timestamptz). PASS: a real change mark for the job at or after changed_at
-- (the change reached the job), the stored snapshot's refresh began after it,
-- and the store answers with that snapshot's time. One statement.
\set zz_check 'stored_reader.change_folded'
\ir ../session.sql
\if :zz_ok
\if :{?changed_at}
WITH x AS (
  SELECT :'changed_at'::timestamptz AS changed_at,
         (SELECT max(m.marked_at) FROM public.job_change_mark_events m WHERE m.job_id = :'zz_job_id'
            AND m.source NOT IN ('profit', 'bulk') AND m.marked_at >= :'changed_at'::timestamptz) AS mark_at,
         (SELECT b.last_marked_at FROM public.job_change_marks_base b WHERE b.job_id = :'zz_job_id'
            AND b.last_marked_at >= :'changed_at'::timestamptz) AS folded_mark_at,
         (SELECT refresh_started_at FROM public.job_story_stored_profit_counts WHERE job_id = :'zz_job_id') AS refresh_started_at,
         (SELECT computed_at FROM public.job_profit_stored WHERE job_id = :'zz_job_id') AS computed_at,
         public.job_story_stored_profit_as_at(:'zz_job_id', now()) AS as_at
)
SELECT :'zz_check' AS "check",
       CASE WHEN coalesce(x.mark_at, x.folded_mark_at) IS NOT NULL
             AND x.refresh_started_at > x.changed_at AND x.computed_at > x.changed_at
             AND x.as_at IS NOT NULL AND x.as_at = x.computed_at THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('changed_at', x.changed_at, 'mark_at', x.mark_at, 'folded_mark_at', x.folded_mark_at,
                          'refresh_started_at', x.refresh_started_at, 'computed_at', x.computed_at,
                          'as_at', x.as_at)::text AS evidence
FROM x;
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result, '{"guard":"psql variable changed_at not given"}' AS evidence;
\endif
\endif
