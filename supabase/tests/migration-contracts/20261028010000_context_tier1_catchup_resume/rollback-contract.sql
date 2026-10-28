-- The runner has just run the down migration: tier 1 is off (the row stays) and catch-up is paused again.
DO $$
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_jev_gate_decides_v1') IS NOT FALSE THEN
    RAISE EXCEPTION 'tier1 rollback contract: the switch is not off';
  END IF;
  IF (SELECT (live_reserve_calls_day, live_reserve_calls_morning) FROM public.context_cadence_settings WHERE id) IS DISTINCT FROM (1000, 750) THEN
    RAISE EXCEPTION 'tier1 rollback contract: catch-up is not paused again';
  END IF;
END $$;
