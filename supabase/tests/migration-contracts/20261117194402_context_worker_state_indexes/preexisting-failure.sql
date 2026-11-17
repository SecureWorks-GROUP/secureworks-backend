CREATE OR REPLACE FUNCTION public.context_worker_state() RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
