-- A later live edit must not be silently overwritten by this migration.
CREATE OR REPLACE FUNCTION public.context_core_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN '{"changed_elsewhere":true}'::jsonb; END $$;
