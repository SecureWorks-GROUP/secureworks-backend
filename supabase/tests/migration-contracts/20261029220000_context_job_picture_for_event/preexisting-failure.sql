-- A live context_job_picture_for_event whose body is not this migration's but
-- whose comment is (as a later migration that changes only the body would
-- leave it): the migration must refuse it and name it, not overwrite it.
\set ON_ERROR_STOP on
CREATE FUNCTION public.context_job_picture_for_event(p_event_id uuid, p_job_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$ SELECT '[]'::jsonb $$;
COMMENT ON FUNCTION public.context_job_picture_for_event(uuid, uuid[]) IS
  'Job picture for an event (20261029220000): drifted body, comment kept.';
