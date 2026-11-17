CREATE OR REPLACE FUNCTION public.match_shadow_report(p_days int DEFAULT 7) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
