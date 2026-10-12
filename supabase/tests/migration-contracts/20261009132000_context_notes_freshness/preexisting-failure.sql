-- Someone else's judge where the lead cutoff's should be, and someone else's function under the
-- name this migration adds: the migration must refuse to overwrite either, naming both.
CREATE OR REPLACE FUNCTION public.context_ledger_judge(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, due boolean, kind text, reason text, priority integer, newest_evidence_at timestamptz,
 evidence_rows integer, generation_id uuid, blocked_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 SELECT NULL::uuid, false, NULL::text, NULL::text, NULL::integer, NULL::timestamptz, 0, NULL::uuid, NULL::text WHERE false
$fn$;
CREATE FUNCTION public.context_ledger_row_unread(p_landed_at timestamptz, p_automated boolean, p_until timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$ SELECT true $fn$;
COMMENT ON FUNCTION public.context_ledger_row_unread(timestamptz, boolean, timestamptz) IS 'Someone else''s rule.';
