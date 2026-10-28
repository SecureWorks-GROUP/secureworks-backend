-- The runner has just run the down migration: Jev is back in shadow and tier 1 is back on.
DO $$
BEGIN
  IF (SELECT bool_and(enabled) FROM public.feature_flags WHERE flag_name IN ('context_jev_shadow_v1','context_jev_gate_decides_v1')) IS NOT TRUE THEN
    RAISE EXCEPTION 'jev off rollback contract: shadow or tier 1 is not back on';
  END IF;
END $$;
