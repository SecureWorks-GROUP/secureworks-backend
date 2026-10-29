-- After the down: the event-keyed picture is gone, the job picture it called
-- is still 20261029200000's body and still answers, and a second run of the
-- down accepts the absence.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regprocedure('public.context_job_picture_for_event(uuid,uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: context_job_picture_for_event remains';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_job_picture(uuid[],text[],text[])'))
     IS DISTINCT FROM '1f3bea8abb27ea2d27b7e710185c738c' THEN
    RAISE EXCEPTION 'rollback: context_job_picture body moved';
  END IF;
  IF jsonb_typeof(public.context_job_picture(ARRAY[]::uuid[])) <> 'array' THEN
    RAISE EXCEPTION 'rollback: context_job_picture does not answer';
  END IF;
END $$;
\ir ../../../rollbacks/20261029220000_context_job_picture_for_event_down.sql
DO $$
BEGIN
  IF to_regprocedure('public.context_job_picture_for_event(uuid,uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: a second down recreated something';
  END IF;
END $$;
