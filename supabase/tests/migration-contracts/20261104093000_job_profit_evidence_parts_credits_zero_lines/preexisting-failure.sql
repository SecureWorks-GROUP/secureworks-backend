-- A definition this migration was not written against: the migration must refuse rather than overwrite it.
CREATE OR REPLACE FUNCTION public.job_profit_line_evidence_score(p_from date DEFAULT '2026-07-01'::date, p_to date DEFAULT '2026-11-01'::date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT jsonb_build_object('rule', 'someone else''s change') $function$;
