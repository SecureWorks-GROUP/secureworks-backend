-- Someone else's change where this migration's pre-images should be: a due list body that is neither
-- 20261009133000's nor this migration's, and a wake function of the same name that is not this
-- migration's. The guard must refuse and name both before touching anything.
CREATE OR REPLACE FUNCTION public.context_ledger_due(p_limit integer DEFAULT 20)
RETURNS TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::integer, NULL::timestamptz WHERE false $fn$;
CREATE FUNCTION public.context_finished_wake_hours() RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 999 $fn$;
COMMENT ON FUNCTION public.context_finished_wake_hours() IS 'Someone else''s window';
