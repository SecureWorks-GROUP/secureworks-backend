-- Deliberately break it: a second sender rule that takes the phone and email
-- straight out of the payload, whoever sent the row. Our own, supplier and
-- council rows then claim a match. The contract must catch it.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION public.context_job_picture_for_event(p_event_id uuid, p_job_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.context_job_picture(p_job_ids,
           ARRAY(SELECT x FROM unnest(ARRAY[e.payload ->> 'phone', e.payload ->> 'customer_phone']) x WHERE x IS NOT NULL),
           ARRAY(SELECT x FROM unnest(ARRAY[e.payload ->> 'from', e.payload ->> 'customer_email']) x WHERE x IS NOT NULL))
    FROM (SELECT 1) one
    LEFT JOIN public.business_events e ON e.id = p_event_id
$$;
