DROP VIEW IF EXISTS public.context_ai_calls_daily;
DROP FUNCTION IF EXISTS public.context_ai_calls_log(jsonb);
DROP FUNCTION IF EXISTS public.context_ai_calls_trim(timestamptz, integer);
DROP TABLE IF EXISTS public.context_ai_calls;
