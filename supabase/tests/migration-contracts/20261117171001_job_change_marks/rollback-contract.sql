-- After the down: the marks table and both functions are gone, and jobs is untouched.
DO $c$
BEGIN
 IF to_regclass('public.job_change_marks') IS NOT NULL THEN
  RAISE EXCEPTION 'job change marks rollback: the table must be dropped';
 END IF;
 IF to_regprocedure('public.job_mark_changed(uuid, text)') IS NOT NULL
    OR to_regprocedure('public.job_marks_notes_seen(timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'job change marks rollback: a function must be dropped';
 END IF;
 IF to_regclass('public.jobs') IS NULL THEN
  RAISE EXCEPTION 'job change marks rollback: public.jobs must remain';
 END IF;
END $c$;
SELECT count(*) FROM public.jobs;
