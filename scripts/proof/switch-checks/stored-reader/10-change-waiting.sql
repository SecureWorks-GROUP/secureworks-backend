-- Stored reader, check 10, on the ZZTEST job: run straight after the
-- director's ZZTEST change (a Xero edit on the job's invoice or bill, synced).
-- PASS: something is waiting for the job (a queued change, a dirty row, or a
-- real change mark newer than the stored refresh's start) and the store gives
-- no as-at time, so the live book is served. FAIL with "nothing waiting"
-- means the change was already folded or never reached the job: run check 11, or
-- make the change again and run this sooner. One statement.
\set zz_check 'stored_reader.change_waiting'
\ir ../session.sql
WITH k AS (
  SELECT refresh_started_at FROM public.job_story_stored_profit_counts WHERE job_id = :'zz_job_id'
), n AS (
  SELECT
    (SELECT count(*) FROM public.job_profit_change_events q WHERE q.job_id = :'zz_job_id') AS queued,
    (SELECT count(*) FROM public.job_profit_dirty d WHERE d.job_id = :'zz_job_id') AS dirty,
    (SELECT count(*) FROM public.job_change_mark_events m LEFT JOIN k ON true WHERE m.job_id = :'zz_job_id'
       AND m.source NOT IN ('profit', 'bulk') AND (k.refresh_started_at IS NULL OR m.marked_at > k.refresh_started_at)) AS newer_marks,
    public.job_story_stored_profit_as_at(:'zz_job_id', now()) AS as_at
)
SELECT :'zz_check' AS "check",
       CASE WHEN n.queued + n.dirty + n.newer_marks > 0 AND n.as_at IS NULL THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('queued', n.queued, 'dirty', n.dirty, 'newer_marks', n.newer_marks, 'as_at', n.as_at,
                          'reading', CASE WHEN n.queued + n.dirty + n.newer_marks = 0 THEN 'nothing waiting'
                                          WHEN n.as_at IS NOT NULL THEN 'stored answer while a change waits'
                                          ELSE 'live book while a change waits' END)::text AS evidence
FROM n;
