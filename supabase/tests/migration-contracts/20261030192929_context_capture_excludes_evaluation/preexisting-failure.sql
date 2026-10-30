CREATE OR REPLACE FUNCTION public.context_source_freshness() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$BEGIN RETURN '{}'::jsonb; END$$;
