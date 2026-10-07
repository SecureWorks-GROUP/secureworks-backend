-- The live email thread bindings to the placeholder job: census, guarded
-- retire (dry run) and the numbers to check (done definition row 3, 7 Oct
-- 2026). Pair with scripts/context-holding-thread-retire-undo.sql. Run it
-- BEFORE any bucket re-run (scripts/context-bucket-rerun-l1g.sql refuses
-- while one of these bindings is live). Production: run each PART on its own.
--
-- Not run by its author. PART 1 is READ ONLY. PART 2 is the WRITE, a dry run:
-- as written it ends in ROLLBACK and changes nothing.
--
-- What they are. event_threads binds an email thread key to the job its first
-- proven placement went to, and the ladder follows a live binding: a later
-- email on that thread lands on the bound job (rules off: step 2; rules on:
-- step 4, when the sender's contact is unknown or the job is one of its
-- candidates). Between 14 and 23 Sep 2026 the ladder bound 50 group-mail
-- threads to the archived placeholder job SWF-PDF-BUCKET
-- (metadata.do_not_schedule, no contact), each from a row that sits on it
-- (measured 7 Oct 2026, read only: 50 live, bound_by ladder, every
-- source_event_id on the placeholder). A placeholder is never a customer's job,
-- so every email that follows one of them is misfiled: on a re-decision both
-- ladders put such a row on the placeholder (L1g evidence, 6 Oct: 6 bucket rows
-- of the last 30 days do exactly that), and 8 rows waiting in the bucket today
-- carry one of these thread keys.
--
-- What the retire does. Each live binding to a holding job is re-keyed
-- retired:holding_job:<its key> and marked retired (retired_at now,
-- retired_reason conflict, the only reason the P4 shape check allows, with
-- retired_conflict_job_id null: the conflict is with the placeholder itself).
-- The re-key is what makes it safe on BOTH ladder paths: a retired binding
-- under its own key would send a later email to review with the placeholder as
-- its only candidate (rules on, thread_retired), while a key no message carries
-- is simply not found, so the email goes on to the contact, reference, address
-- and bucket rules, and its first proven placement binds the thread afresh to a
-- real job. The binding row itself stays (job, bound_by, bound_at,
-- source_event_id untouched), so the undo can put it back exactly. P4's
-- rollback re-keys retired rows with a retired: prefix too; a second prefix is
-- harmless (no message carries either).
--
-- What it does not do. No business_events row moves: the 55 rows on the
-- placeholder that sit there through these threads (the 50 that bound them and
-- 5 placed by them) stay where they are; the 8 bucket rows move only when the
-- bucket re-run re-decides them. No other binding, table or flag is touched.
--
-- How to run (production: read only first, a write only with the owner's go).
--   PART 1  read-only census. Must show 50 live bindings to holding jobs (it
--           only grows if the ladder binds another thread to a holding job,
--           which needs a direct or content_ref placement onto one). Copy
--           live_bindings into PART 2.
--   PART 2  guarded retire. As written it ends in ROLLBACK: a dry run that
--           retires, checks and throws it away. It refuses unless the locked
--           set is exactly expected_bindings, no retired:holding_job: key it
--           would write already exists, and afterwards no live binding points
--           at a holding job and nothing but the re-keyed rows changed.
--           To apply (owner's go only): change the final ROLLBACK to COMMIT and
--           run PART 2 once.
--   UNDO    scripts/context-holding-thread-retire-undo.sql restores each key
--           and clears the three retired columns.

-- ============================================================================
-- PART 1. READ ONLY.
-- ============================================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';

-- 1. The live bindings to holding jobs, by job and binder.
SELECT j.job_number, t.bound_by, count(*) AS live_bindings, min(t.bound_at) AS first_bound, max(t.bound_at) AS last_bound,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.business_events b WHERE b.id = t.source_event_id AND b.job_id = t.job_id)) AS source_row_on_it,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.event_threads x WHERE x.thread_key = 'retired:holding_job:' || t.thread_key)) AS retired_key_taken
FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1')
GROUP BY j.job_number, t.bound_by ORDER BY j.job_number COLLATE "C", t.bound_by COLLATE "C";

-- 2. The rows that follow those threads: on the holding job, waiting in the bucket, or elsewhere.
SELECT x.sits, count(*) AS rows, count(DISTINCT x.thread_key) AS threads, min(x.cap)::date AS first_captured, max(x.cap)::date AS last_captured
FROM (SELECT CASE WHEN b.job_id = t.job_id THEN 'on_holding_job' WHEN b.job_id IS NULL THEN 'no_job:' || coalesce(b.attribution_status, '-')
                  ELSE 'other_job' END AS sits, b.thread_key, coalesce(b.context_captured_at, b.recorded_at) AS cap
      FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
      JOIN public.business_events b ON b.thread_key = t.thread_key
      WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1')) x
GROUP BY x.sits ORDER BY x.sits COLLATE "C";

-- 3. The count to copy into PART 2.
SELECT count(*) AS live_bindings
FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1');
ROLLBACK;

-- ============================================================================
-- PART 2. WRITE (dry run).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE tr_before ON COMMIT DROP AS
SELECT t.* FROM public.event_threads t;

CREATE TEMP TABLE tr_batch ON COMMIT DROP AS
SELECT t.thread_key, t.job_id, t.bound_by, t.bound_at, t.source_event_id
FROM public.event_threads t
WHERE t.retired_at IS NULL
  AND t.job_id IN (SELECT j.id FROM public.jobs j WHERE coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'))
FOR UPDATE OF t;

DO $count$
DECLARE
 -- The live_bindings figure PART 1 printed (50 on 7 Oct 2026). The write refuses on any other count.
 expected_bindings constant integer := 50;
 n integer;
BEGIN
 SELECT count(*) INTO n FROM tr_batch;
 IF n <> expected_bindings THEN
  RAISE EXCEPTION 'holding_thread_retire: % live bindings to holding jobs, expected %; re-run PART 1', n, expected_bindings;
 END IF;
 IF EXISTS (SELECT 1 FROM tr_batch b JOIN public.event_threads x ON x.thread_key = 'retired:holding_job:' || b.thread_key) THEN
  RAISE EXCEPTION 'holding_thread_retire: a retired:holding_job: key it would write already exists; refusing';
 END IF;
 IF EXISTS (SELECT 1 FROM tr_batch b WHERE b.thread_key LIKE 'retired:%') THEN
  RAISE EXCEPTION 'holding_thread_retire: a live binding already carries a retired: key; refusing';
 END IF;
END $count$;

UPDATE public.event_threads t
SET thread_key = 'retired:holding_job:' || t.thread_key, retired_at = now(), retired_reason = 'conflict', retired_conflict_job_id = NULL
FROM tr_batch b WHERE t.thread_key = b.thread_key;

DO $check$
DECLARE n integer; want integer := (SELECT count(*) FROM tr_batch);
BEGIN
 -- No live binding points at a holding job.
 SELECT count(*) INTO n FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
 WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1');
 IF n <> 0 THEN RAISE EXCEPTION 'holding_thread_retire: % live bindings still point at a holding job; refusing', n; END IF;
 -- Every batch row is re-keyed and retired, everything else on it kept.
 SELECT count(*) INTO n FROM tr_batch b JOIN public.event_threads t ON t.thread_key = 'retired:holding_job:' || b.thread_key
 WHERE t.job_id = b.job_id AND t.bound_by = b.bound_by AND t.bound_at = b.bound_at
   AND t.source_event_id IS NOT DISTINCT FROM b.source_event_id
   AND t.retired_at IS NOT NULL AND t.retired_reason = 'conflict' AND t.retired_conflict_job_id IS NULL;
 IF n <> want THEN RAISE EXCEPTION 'holding_thread_retire: % of % bindings came out re-keyed and retired; refusing', n, want; END IF;
 IF EXISTS (SELECT 1 FROM tr_batch b JOIN public.event_threads t ON t.thread_key = b.thread_key) THEN
  RAISE EXCEPTION 'holding_thread_retire: an original key is still bound; refusing';
 END IF;
 -- Nothing else changed (a binding the live ladder adds meanwhile is not this run's and is not compared).
 IF EXISTS (SELECT 1 FROM tr_before o
             WHERE NOT EXISTS (SELECT 1 FROM tr_batch b WHERE b.thread_key = o.thread_key)
               AND NOT EXISTS (SELECT 1 FROM public.event_threads t WHERE t.thread_key = o.thread_key
                                AND to_jsonb(t) = to_jsonb(o))) THEN
  RAISE EXCEPTION 'holding_thread_retire: a binding outside the batch changed; refusing';
 END IF;
END $check$;

SELECT j.job_number, count(*) AS retired_now
FROM tr_batch b JOIN public.jobs j ON j.id = b.job_id GROUP BY j.job_number ORDER BY j.job_number COLLATE "C";
ROLLBACK;
