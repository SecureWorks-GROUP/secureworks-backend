CREATE OR REPLACE FUNCTION public.context_ai_harness_save(p_rows jsonb)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS 'SELECT 0';
