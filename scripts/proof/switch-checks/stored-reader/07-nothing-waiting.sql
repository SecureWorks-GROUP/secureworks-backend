-- Stored reader, check 7, on the ZZTEST job: nothing is waiting. No
-- queued profit change, no dirty row, and no change mark newer than the start
-- of the refresh that stored the snapshot (the store's own 'profit' and
-- 'bulk' marks are left out; a folded mark keeps no source and counts).
-- The same tests as job_story_stored_profit_as_at, shown one by one.
\set zz_check 'stored_reader.nothing_waiting'
\ir ../session.sql
WITH k AS (
  SELECT refresh_started_at FROM public.job_story_stored_profit_counts WHERE job_id = :'zz_job_id'
), n AS (
  SELECT
    (SELECT count(*) FROM public.job_profit_change_events q WHERE q.job_id = :'zz_job_id') AS queued,
    (SELECT count(*) FROM public.job_profit_dirty d WHERE d.job_id = :'zz_job_id') AS dirty,
    (SELECT count(*) FROM public.job_change_mark_events m, k WHERE m.job_id = :'zz_job_id'
       AND m.source NOT IN ('profit', 'bulk') AND m.marked_at > k.refresh_started_at) AS newer_marks,
    (SELECT count(*) FROM public.job_change_marks_base b, k WHERE b.job_id = :'zz_job_id'
       AND b.last_marked_at > k.refresh_started_at) AS newer_folded_marks,
    (SELECT refresh_started_at FROM k) AS refresh_started_at
)
SELECT :'zz_check' AS "check",
       CASE WHEN n.refresh_started_at IS NOT NULL AND n.queued = 0 AND n.dirty = 0
             AND n.newer_marks = 0 AND n.newer_folded_marks = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('job_number', :'job_number', 'refresh_started_at', n.refresh_started_at,
                          'queued', n.queued, 'dirty', n.dirty, 'newer_marks', n.newer_marks,
                          'newer_folded_marks', n.newer_folded_marks)::text AS evidence
FROM n;
