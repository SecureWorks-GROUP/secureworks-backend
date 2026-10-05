-- Rollback for 20261006011000_context_job_record.sql: drops the five record
-- functions and the two inbox_events indexes it added. Nothing else is touched.
-- Refuses while the story (20261006014000) is installed: the story reads these
-- functions, so roll the story back first.
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
 IF to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)') IS NOT NULL THEN
  RAISE EXCEPTION 'context_job_record_down_refused: roll back 20261006014000_context_job_story first';
 END IF;
END $guard$;
DROP FUNCTION IF EXISTS public.context_job_record_contact(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_money(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_loops(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_timeline(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_messages(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_legacy_mail(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.context_job_record_date(text);
DROP INDEX IF EXISTS public.inbox_events_from_email_record;
DROP INDEX IF EXISTS public.inbox_events_job_id_record;
