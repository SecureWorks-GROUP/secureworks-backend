CREATE OR REPLACE FUNCTION public.context_coverage() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT '{}'::jsonb $$;
