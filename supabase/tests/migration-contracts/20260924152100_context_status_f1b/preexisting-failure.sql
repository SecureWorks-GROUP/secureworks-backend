-- Live changes nobody read: the money block already replaced by some other
-- body (as if a money slice had landed first) and a window_end_id column in
-- another collation. The guard must refuse and name both.
CREATE OR REPLACE FUNCTION public.context_money_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT '{"alarms":[]}'::jsonb $$;
ALTER TABLE public.context_capture_runs ADD COLUMN window_end_id text;
