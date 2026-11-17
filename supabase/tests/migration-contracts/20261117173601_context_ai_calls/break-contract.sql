CREATE OR REPLACE FUNCTION public.context_ai_calls_log(p_rows jsonb)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS 'SELECT 0';
