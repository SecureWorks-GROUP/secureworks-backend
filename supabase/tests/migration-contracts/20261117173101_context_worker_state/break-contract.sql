-- Break elapsed backoff by emptying the new overload only.
CREATE OR REPLACE FUNCTION public.context_attribution_due(p_lane text, p_limit integer DEFAULT 20)
RETURNS SETOF public.business_events LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  RETURN;
END $$;
