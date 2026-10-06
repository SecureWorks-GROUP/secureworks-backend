-- Grade capture lanes on the wall clock instead of Perth working time: the
-- quiet hours overnight and on Sunday would count against a lane, and the
-- contract's "overnight counted against quotes" check must catch it.
CREATE OR REPLACE FUNCTION public.context_business_minutes(p_from timestamptz, p_to timestamptz) RETURNS integer
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
 SELECT CASE WHEN p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN 0
             ELSE floor(extract(epoch FROM (p_to - p_from)) / 60)::integer END
$$;
