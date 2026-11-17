-- Rule 15: a body this migration would replace is not FU26.1's (a later
-- change replaced it). The migration must refuse rather than overwrite it.
CREATE OR REPLACE FUNCTION public.job_story_stored_profit_as_at(p_job_id uuid,p_as_of timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE AS $f$ SELECT NULL::timestamptz $f$;
