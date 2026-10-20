-- A foreign function already holds the reader's name: the migration must refuse
-- rather than replace it.
CREATE FUNCTION public.context_job_superseded_during(p_job uuid, p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
COMMENT ON FUNCTION public.context_job_superseded_during(uuid, timestamptz) IS 'someone else''s reader';
