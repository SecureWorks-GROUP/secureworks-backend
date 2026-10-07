-- Undo for scripts/context-holding-thread-retire.sql (7 Oct 2026).
--
-- Puts back every binding the retire re-keyed: each retired:holding_job:<key>
-- row on a holding job gets its own key again and its three retired columns
-- cleared (P4: "Reversible by clearing the three columns"), so the thread is
-- followed onto the placeholder once more. Job, bound_by, bound_at and
-- source_event_id were never changed. No other binding and no business row is
-- touched.
--
-- It refuses when an original key has been bound again since the retire (the
-- ladder bound the thread to a real job after a proven placement): putting the
-- placeholder back would mean deleting that newer, correct binding, which this
-- undo never does. Rows a bucket re-run placed through the freed threads are
-- not moved back here; undo the re-run first
-- (scripts/context-bucket-rerun-l1g-undo.sql), then this file.
--
-- How to run (production: a write only with the owner's go). As written it
-- ends in ROLLBACK: a dry run. First read the count:
--   BEGIN READ ONLY;
--   SELECT count(*) FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
--    WHERE t.thread_key LIKE 'retired:holding_job:%' AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1');
--   ROLLBACK;
-- put it in expected_rows below, run this file, then (owner's go) change the
-- final ROLLBACK to COMMIT and run it once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE tr_undo ON COMMIT DROP AS
SELECT t.thread_key AS retired_key, substr(t.thread_key, length('retired:holding_job:') + 1) AS original_key,
 t.job_id, t.bound_by, t.bound_at, t.source_event_id
FROM public.event_threads t
WHERE t.thread_key LIKE 'retired:holding_job:%' AND t.retired_at IS NOT NULL AND t.retired_reason = 'conflict'
  AND t.retired_conflict_job_id IS NULL
  AND t.job_id IN (SELECT j.id FROM public.jobs j WHERE coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'))
FOR UPDATE OF t;

DO $undo$
DECLARE
 -- The number of bindings the retire committed (50 if it ran as measured on 7 Oct 2026).
 expected_rows constant integer := 50;
 n integer;
BEGIN
 SELECT count(*) INTO n FROM tr_undo;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'holding_thread_retire undo: % retired holding bindings, expected %; refusing', n, expected_rows;
 END IF;
 SELECT count(*) INTO n FROM tr_undo u JOIN public.event_threads t ON t.thread_key = u.original_key;
 IF n <> 0 THEN
  RAISE EXCEPTION 'holding_thread_retire undo: % threads were bound again since the retire; refusing to replace those bindings', n;
 END IF;
 UPDATE public.event_threads t
 SET thread_key = u.original_key, retired_at = NULL, retired_reason = NULL, retired_conflict_job_id = NULL
 FROM tr_undo u WHERE t.thread_key = u.retired_key;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> expected_rows THEN RAISE EXCEPTION 'holding_thread_retire undo: restored % bindings, expected %; refusing', n, expected_rows; END IF;
 SELECT count(*) INTO n FROM tr_undo u JOIN public.event_threads t ON t.thread_key = u.original_key
 WHERE t.job_id = u.job_id AND t.bound_by = u.bound_by AND t.bound_at = u.bound_at
   AND t.source_event_id IS NOT DISTINCT FROM u.source_event_id
   AND t.retired_at IS NULL AND t.retired_reason IS NULL AND t.retired_conflict_job_id IS NULL;
 IF n <> expected_rows THEN RAISE EXCEPTION 'holding_thread_retire undo: % of % bindings read as before the retire; refusing', n, expected_rows; END IF;
END $undo$;
SELECT count(*) AS live_bindings_to_holding_jobs_after_undo
FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1');
ROLLBACK;
