-- Weaken the strain test on purpose. The contract must reject this body.
CREATE OR REPLACE FUNCTION public.director_cost_watchdog_tick(p_guard text)
RETURNS void
LANGUAGE plpgsql
AS $weak$
BEGIN
  UPDATE public.feature_flags
     SET enabled = false
   WHERE flag_name = 'job_profit_refresh_v1'
     AND enabled
     AND (s.slow >= 40 OR s.conns >= 1200);
END
$weak$;
