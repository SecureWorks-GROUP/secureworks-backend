-- Someone else's change where this migration's pre-image should be: a judge body that is neither
-- 20261012093500's nor this migration's. The guard must refuse and name it before touching anything.
CREATE OR REPLACE FUNCTION public.context_ledger_judge(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, due boolean, kind text, reason text, priority integer, newest_evidence_at timestamptz,
 evidence_rows integer, generation_id uuid, blocked_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT NULL::uuid, NULL::boolean, NULL::text, NULL::text, NULL::integer, NULL::timestamptz, NULL::integer, NULL::uuid, NULL::text WHERE false $fn$;
