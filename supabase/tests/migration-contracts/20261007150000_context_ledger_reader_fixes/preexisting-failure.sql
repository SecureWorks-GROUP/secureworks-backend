-- Someone else's packet where the store's should be, and someone else's function under one of
-- the names this migration adds: the migration must refuse to overwrite either, naming both.
CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamptz DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ SELECT '{}'::jsonb $fn$;
CREATE FUNCTION public.context_ledger_siblings(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ SELECT '{}'::jsonb $fn$;
COMMENT ON FUNCTION public.context_ledger_siblings(uuid, timestamptz) IS 'Someone else''s sibling read.';
