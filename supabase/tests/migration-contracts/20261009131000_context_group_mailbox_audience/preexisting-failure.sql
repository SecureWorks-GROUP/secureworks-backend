-- Someone else's function under one of the names this migration adds: the migration must refuse
-- to overwrite it, and say which.
CREATE FUNCTION public.context_email_audience_plan()
RETURNS TABLE(event_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ SELECT NULL::uuid $fn$;
COMMENT ON FUNCTION public.context_email_audience_plan() IS 'Someone else''s audience plan.';
