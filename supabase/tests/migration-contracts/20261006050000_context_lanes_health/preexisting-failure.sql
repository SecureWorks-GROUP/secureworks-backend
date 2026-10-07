-- A live change nobody read: the GHL status block replaced by another body.
-- The guard must refuse and name it rather than silently revert it.
CREATE OR REPLACE FUNCTION public.context_ghl_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT '{"alarms":[]}'::jsonb $$;
