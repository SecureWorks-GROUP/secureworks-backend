-- A capture_business_event nobody read is already live: the migration must refuse
-- rather than replace it.
CREATE FUNCTION public.capture_business_event(p_row jsonb) RETURNS jsonb
LANGUAGE sql AS $$ SELECT '{"outcome":"someone else"}'::jsonb $$;
