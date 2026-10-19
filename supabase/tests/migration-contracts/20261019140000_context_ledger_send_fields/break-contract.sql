-- An empty stand-in keeps the comment, the search path and the security
-- definer mark. Shape checks still pass. The first behaviour check, a single
-- email recipient copied onto the system_email link, is what fails.
CREATE OR REPLACE FUNCTION public.context_ledger_evidence_record_links(p_job_id uuid, p_as_of timestamptz, p_sources jsonb)
RETURNS TABLE(src_table text, src_id uuid, records jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT NULL::text, NULL::uuid, NULL::jsonb WHERE false
$fn$;
COMMENT ON FUNCTION public.context_ledger_evidence_record_links(uuid, timestamptz, jsonb) IS
 'Ledger packet records (20261018120000): broken on purpose. Send recipient fields (20261019140000): broken on purpose.';
