-- A status body that was not read must stop the follow-up migration.
CREATE OR REPLACE FUNCTION public.context_ghl_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT '{"alarms":[]}'::jsonb $$;
