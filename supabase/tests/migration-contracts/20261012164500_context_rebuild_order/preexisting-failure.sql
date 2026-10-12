-- Someone else's change where this migration's pre-image should be: a due list body that is neither
-- 20261012093500's nor this migration's. The guard must refuse and name it before touching anything.
CREATE OR REPLACE FUNCTION public.context_ledger_due(p_limit integer DEFAULT 20)
RETURNS TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::integer, NULL::timestamptz WHERE false $fn$;
