-- Deliberately break the rule: any superseded event ever counts, and the clear
-- is ignored. CREATE OR REPLACE keeps the comment and the grants, so only the
-- behaviour breaks and the contract must catch it.
CREATE OR REPLACE FUNCTION public.context_job_superseded_during(p_job uuid, p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
 SELECT CASE WHEN p_job IS NULL OR p_at IS NULL THEN NULL::boolean ELSE EXISTS (
   SELECT 1 FROM public.job_events e
    WHERE e.job_id = p_job
      AND e.event_type = 'quote_option_superseded'
      AND e.created_at <= p_at) END
$fn$;
