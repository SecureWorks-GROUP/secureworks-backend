-- Someone else's body where a 972 one should be: the story fixes must refuse to
-- overwrite it (its live md5 is neither the 972 one nor this migration's).
CREATE OR REPLACE FUNCTION public.context_client_story(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT NULL::jsonb $fn$;
