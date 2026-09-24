-- A replaced function has drifted from K1's body (a hand-applied change
-- nobody read), and the list's name is already taken by another table. The
-- guard must stop before replacing anything and name each one.
CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT '{"drift":true}'::jsonb $$;
CREATE TABLE public.context_catchup_jobs (job_id uuid PRIMARY KEY);
