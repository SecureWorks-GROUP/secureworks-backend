-- Live changes nobody read: the core status already carries some other body,
-- and a table named ops_api_actor_calls already exists with another shape.
-- The guard must refuse and name both, before anything is created.
CREATE OR REPLACE FUNCTION public.context_core_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT '{"as_of":null}'::jsonb $$;
CREATE TABLE public.ops_api_actor_calls (
 day date,
 missing integer,
 first_at timestamptz,
 last_at timestamptz
);
ALTER TABLE public.ops_api_actor_calls ENABLE ROW LEVEL SECURITY;
