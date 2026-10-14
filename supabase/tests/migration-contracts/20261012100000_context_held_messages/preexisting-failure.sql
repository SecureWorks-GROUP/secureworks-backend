-- Someone else's change where this migration's pre-image should be: a packet body that is neither
-- 20261007150000's nor this migration's. The guard must refuse before touching anything.
CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamptz DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ SELECT '{}'::jsonb $fn$;
