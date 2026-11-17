-- Stand the historical mark/build contract back up; the successor has its own proofs.
SELECT to_regclass('public.job_change_marks_base') IS NOT NULL AS queue_safety_live \gset
\if :queue_safety_live
\ir ../../../rollbacks/20261117172503_job_pages_queue_safety_down.sql
\endif
-- Changed-job marks contract (P0-02.1). One ZZTEST-401 job, rolled back:
-- (a) a first mark makes one row with its source; (b) a second source is added once and last_marked_at moves on;
-- (c) after the page is done a new mark starts a new run (sources reset, first_marked_at moves forward);
-- (d) a null job and an unknown job do nothing and raise nothing; (e) job_marks_notes_seen moves one row, then none.
-- Then the table and function grants, row level security and the comment, and a re-apply is a no-op.
BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number)
VALUES ('00000000-0000-4000-8000-000000000401', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'ZZTEST-401');
CREATE TEMP TABLE jcm_seen (step text PRIMARY KEY, first_at timestamptz, last_at timestamptz) ON COMMIT DROP;

-- (a)
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000401', 'message');
DO $c$
DECLARE r public.job_change_marks;
BEGIN
 IF (SELECT count(*) FROM public.job_change_marks) <> 1 THEN
  RAISE EXCEPTION 'job change marks (a): expected 1 row, found %', (SELECT count(*) FROM public.job_change_marks);
 END IF;
 SELECT * INTO r FROM public.job_change_marks WHERE job_id = '00000000-0000-4000-8000-000000000401';
 IF r.sources IS DISTINCT FROM '{message}'::text[] THEN
  RAISE EXCEPTION 'job change marks (a): sources are %', r.sources;
 END IF;
 IF r.page_done_at IS NOT NULL OR r.notes_done_at IS NOT NULL OR r.story_done_at IS NOT NULL THEN
  RAISE EXCEPTION 'job change marks (a): a done column was set by a mark';
 END IF;
 INSERT INTO jcm_seen VALUES ('a', r.first_marked_at, r.last_marked_at);
END $c$;

-- (b)
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000401', 'invoice');
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000401', ' invoice ');
DO $c$
DECLARE r public.job_change_marks; s jcm_seen;
BEGIN
 SELECT * INTO s FROM jcm_seen WHERE step = 'a';
 IF (SELECT count(*) FROM public.job_change_marks) <> 1 THEN
  RAISE EXCEPTION 'job change marks (b): expected 1 row, found %', (SELECT count(*) FROM public.job_change_marks);
 END IF;
 SELECT * INTO r FROM public.job_change_marks WHERE job_id = '00000000-0000-4000-8000-000000000401';
 IF r.sources IS DISTINCT FROM '{message,invoice}'::text[] THEN
  RAISE EXCEPTION 'job change marks (b): sources are %', r.sources;
 END IF;
 IF NOT r.last_marked_at > s.last_at THEN
  RAISE EXCEPTION 'job change marks (b): last_marked_at did not move on (% then %)', s.last_at, r.last_marked_at;
 END IF;
 IF r.first_marked_at IS DISTINCT FROM s.first_at THEN
  RAISE EXCEPTION 'job change marks (b): first_marked_at moved inside one run of changes';
 END IF;
 INSERT INTO jcm_seen VALUES ('b', r.first_marked_at, r.last_marked_at);
END $c$;

-- (c)
UPDATE public.job_change_marks SET page_done_at = last_marked_at WHERE job_id = '00000000-0000-4000-8000-000000000401';
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000401', 'booking');
DO $c$
DECLARE r public.job_change_marks; s jcm_seen;
BEGIN
 SELECT * INTO s FROM jcm_seen WHERE step = 'b';
 SELECT * INTO r FROM public.job_change_marks WHERE job_id = '00000000-0000-4000-8000-000000000401';
 IF r.sources IS DISTINCT FROM '{booking}'::text[] THEN
  RAISE EXCEPTION 'job change marks (c): after the page was done sources are %', r.sources;
 END IF;
 IF NOT r.first_marked_at > s.first_at THEN
  RAISE EXCEPTION 'job change marks (c): first_marked_at did not move forward (% then %)', s.first_at, r.first_marked_at;
 END IF;
 IF NOT r.last_marked_at > r.page_done_at THEN
  RAISE EXCEPTION 'job change marks (c): the job is not due for its page after a new mark';
 END IF;
 -- A blank source is recorded as unknown, once.
 PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000401', '  ');
 PERFORM public.job_mark_changed('00000000-0000-4000-8000-000000000401', NULL);
 SELECT * INTO r FROM public.job_change_marks WHERE job_id = '00000000-0000-4000-8000-000000000401';
 IF r.sources IS DISTINCT FROM '{booking,unknown}'::text[] THEN
  RAISE EXCEPTION 'job change marks (c): a blank source gave sources %', r.sources;
 END IF;
END $c$;

-- (d)
SELECT public.job_mark_changed(NULL, 'x');
SELECT public.job_mark_changed(gen_random_uuid(), 'x');
DO $c$
BEGIN
 IF (SELECT count(*) FROM public.job_change_marks) <> 1 THEN
  RAISE EXCEPTION 'job change marks (d): a null or unknown job made a row (% rows)', (SELECT count(*) FROM public.job_change_marks);
 END IF;
END $c$;

-- (e)
DO $c$
DECLARE n integer; r public.job_change_marks;
BEGIN
 n := public.job_marks_notes_seen(clock_timestamp());
 IF n <> 1 THEN RAISE EXCEPTION 'job change marks (e): the first notes_seen moved % rows, expected 1', n; END IF;
 SELECT * INTO r FROM public.job_change_marks WHERE job_id = '00000000-0000-4000-8000-000000000401';
 IF r.notes_done_at IS DISTINCT FROM r.last_marked_at THEN
  RAISE EXCEPTION 'job change marks (e): notes_done_at is % not last_marked_at %', r.notes_done_at, r.last_marked_at;
 END IF;
 n := public.job_marks_notes_seen(clock_timestamp());
 IF n <> 0 THEN RAISE EXCEPTION 'job change marks (e): the second notes_seen moved % rows, expected 0', n; END IF;
END $c$;

-- A job deleted takes its mark with it.
DELETE FROM public.jobs WHERE id = '00000000-0000-4000-8000-000000000401';
DO $c$
BEGIN
 IF EXISTS (SELECT 1 FROM public.job_change_marks) THEN
  RAISE EXCEPTION 'job change marks: a deleted job kept its mark';
 END IF;
END $c$;
ROLLBACK;

-- Grants, row level security, the comment, and the two due indexes.
DO $c$
BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_change_marks'::regclass) THEN
  RAISE EXCEPTION 'job change marks: row level security is off';
 END IF;
 IF has_table_privilege('anon', 'public.job_change_marks', 'SELECT')
    OR has_table_privilege('authenticated', 'public.job_change_marks', 'SELECT')
    OR has_table_privilege('authenticated', 'public.job_change_marks', 'INSERT') THEN
  RAISE EXCEPTION 'job change marks: a browser role can read or write the table';
 END IF;
 IF NOT has_table_privilege('service_role', 'public.job_change_marks', 'SELECT, INSERT, UPDATE, DELETE') THEN
  RAISE EXCEPTION 'job change marks: service_role lacks a table grant';
 END IF;
 IF has_function_privilege('anon', 'public.job_mark_changed(uuid, text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.job_mark_changed(uuid, text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.job_marks_notes_seen(timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.job_marks_notes_seen(timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'job change marks: a browser role can run a marks function';
 END IF;
 IF NOT has_function_privilege('service_role', 'public.job_mark_changed(uuid, text)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.job_marks_notes_seen(timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'job change marks: service_role cannot run a marks function';
 END IF;
 IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.job_mark_changed(uuid, text)'::regprocedure)
    OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.job_marks_notes_seen(timestamptz)'::regprocedure) THEN
  RAISE EXCEPTION 'job change marks: a marks function is not SECURITY DEFINER';
 END IF;
 IF coalesce(obj_description('public.job_change_marks'::regclass, 'pg_class'), '') NOT LIKE 'One row per job that changed.%' THEN
  RAISE EXCEPTION 'job change marks: the table comment is missing';
 END IF;
 IF to_regclass('public.job_change_marks_page_due') IS NULL OR to_regclass('public.job_change_marks_notes_due') IS NULL THEN
  RAISE EXCEPTION 'job change marks: a due index is missing';
 END IF;
END $c$;

-- A re-apply is a no-op.
BEGIN;
\ir ../../../migrations/20261117171302_job_change_marks.sql
DO $c$
BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE proname IN ('job_mark_changed', 'job_marks_notes_seen')
      AND pronamespace = 'public'::regnamespace) <> 2 THEN
  RAISE EXCEPTION 'job change marks: a re-apply duplicated a function';
 END IF;
END $c$;
ROLLBACK;

-- Restore the successor for the remaining registered cases.
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
