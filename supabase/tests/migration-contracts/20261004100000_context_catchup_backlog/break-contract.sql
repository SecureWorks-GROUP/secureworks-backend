-- Ship the list without the unread mode: the pending read goes back to
-- 20260924220000's body, so a re-opened job re-reads every row it already
-- read. The contract must catch it.
CREATE OR REPLACE FUNCTION public.context_catchup_pending_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.* FROM public.context_catchup_eligible_rows(p_job_ids) e
 JOIN public.context_catchup_jobs c ON c.job_id=e.job_id AND c.done_at IS NULL
 WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=e.job_id AND r.event_id=e.id)
$$;
