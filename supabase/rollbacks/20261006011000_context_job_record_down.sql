-- Rollback for 20261006011000_context_job_record.sql: drops the five record
-- functions. Nothing else is touched (the migration created nothing else).
-- Refuses while the story (20261006012000) is installed: the story reads these
-- functions, so roll the story back first.
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
 IF to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'context_job_record_down_refused: roll back 20261006012000_context_job_story first';
 END IF;
END $guard$;
DROP FUNCTION IF EXISTS public.context_job_record_contact(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_money(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_loops(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_timeline(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_messages(uuid[], timestamptz);
