-- The registered stack omits 20261102140000's one-job wrapper. Supply its
-- exact body and grants if absent. Its batch implementation is the real one.
DO $fixture$ BEGIN
 IF to_regprocedure('public.job_profit_line_evidence(uuid)') IS NULL THEN
  CREATE FUNCTION public.job_profit_line_evidence(p_job_id uuid)
  RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
SELECT m.result FROM public.job_profit_line_evidence_many(ARRAY[p_job_id]) m;
$fn$;
  REVOKE ALL ON FUNCTION public.job_profit_line_evidence(uuid) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.job_profit_line_evidence(uuid) TO service_role;
 END IF;
END $fixture$;
