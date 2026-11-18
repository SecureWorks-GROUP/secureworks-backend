-- Someone else's body on the page function: the migration must refuse.
CREATE OR REPLACE FUNCTION public.reconcile_list_page(
  p_org uuid, p_kinds text[], p_limit integer, p_after jsonb DEFAULT NULL)
RETURNS TABLE (
  id uuid, kind text, subject_table text, subject_id text, job_ids uuid[],
  reason text, amount_ex numeric, document_date date, summary jsonb,
  suggestion jsonb, evidence jsonb, evidence_hash text, raised_at timestamptz,
  snooze_until timestamptz, snoozed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT t.id, t.kind, t.subject_table, t.subject_id, t.job_ids, t.reason, t.amount_ex, t.document_date,
    t.summary, t.suggestion, t.evidence, t.evidence_hash, t.raised_at, t.snooze_until, false
  FROM public.reconcile_items t WHERE t.org_id = p_org
$fn$;
