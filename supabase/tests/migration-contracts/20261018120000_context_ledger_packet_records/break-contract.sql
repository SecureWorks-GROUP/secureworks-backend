-- The records array is produced by one function. An empty stand-in keeps the
-- comment and the search path, so the shape checks still pass and the first
-- behaviour check (a paid bill on the worded row) is what fails.
CREATE OR REPLACE FUNCTION public.context_ledger_evidence_record_links(p_job_id uuid, p_as_of timestamptz, p_sources jsonb)
RETURNS TABLE(src_table text, src_id uuid, records jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT NULL::text, NULL::uuid, NULL::jsonb WHERE false
$fn$;
COMMENT ON FUNCTION public.context_ledger_evidence_record_links(uuid, timestamptz, jsonb) IS
 'Ledger packet records (20261018120000): broken on purpose.';
