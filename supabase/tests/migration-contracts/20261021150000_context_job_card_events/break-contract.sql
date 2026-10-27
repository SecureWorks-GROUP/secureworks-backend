-- Restore the read the card used before: every row where the ladder put it (business_events.job_id),
-- whatever a person decided. The split must then fail to reach the cards.
CREATE OR REPLACE FUNCTION public.context_job_card_events(p_job_ids uuid[])
RETURNS TABLE (job_id uuid, event_id uuid, by_person boolean)
LANGUAGE sql STABLE
AS $fn$
 SELECT e.job_id, e.id, false FROM public.business_events e WHERE e.job_id = ANY (p_job_ids)
$fn$;
