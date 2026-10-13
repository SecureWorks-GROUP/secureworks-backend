-- Ship the wrapper without the setting: it answers the bare policy whatever calls_per_day says,
-- so the seven readers, the bounds and the column are all in place and a raise still does
-- nothing. The contract must catch it at the first raise it tries.
CREATE OR REPLACE FUNCTION public.context_cadence_policy_today()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $wrapper$
BEGIN
 RETURN public.context_cadence_policy();
END $wrapper$;
