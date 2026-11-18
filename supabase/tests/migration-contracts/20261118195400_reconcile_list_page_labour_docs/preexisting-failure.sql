-- Someone else's body on the counts function: the migration must refuse.
CREATE OR REPLACE FUNCTION public.reconcile_list_counts(p_org uuid)
RETURNS TABLE (kind text, open bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT t.kind, count(*) FROM public.reconcile_items t WHERE t.org_id = p_org GROUP BY t.kind
$fn$;
