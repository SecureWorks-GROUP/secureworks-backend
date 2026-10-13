-- Deliberately stop the judge hearing of requests: where a request stands answers with no row, as
-- if none were on file, and everything else stays as the migration left it. contract.sql must then
-- fail on its first check of the judge itself, section 1: a job with a request on file is not due.
CREATE OR REPLACE FUNCTION public.context_ledger_rebuild_request_state(p_job_ids uuid[] DEFAULT NULL)
RETURNS TABLE(request_id uuid, job_id uuid, requested_by text, reason text, requested_at timestamptz, state text, failed_reads integer,
 read_generation_id uuid, read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::text, NULL::integer, NULL::uuid, NULL::timestamptz WHERE false $fn$;
