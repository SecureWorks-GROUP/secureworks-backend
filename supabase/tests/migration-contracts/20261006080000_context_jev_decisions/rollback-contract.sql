-- After the Jev rollback: the log, both reads and the flag row are gone, and
-- feature_flags (with its other rows) is untouched.
DO $$
BEGIN
 IF to_regclass('public.context_jev_decisions') IS NOT NULL THEN RAISE EXCEPTION 'jev rollback: the log was left behind'; END IF;
 IF to_regprocedure('public.context_jev_agreement(timestamptz,timestamptz)') IS NOT NULL
  OR to_regprocedure('public.context_jev_calls_today()') IS NOT NULL THEN
  RAISE EXCEPTION 'jev rollback: a Jev read was left behind';
 END IF;
 IF to_regclass('public.feature_flags') IS NULL THEN RAISE EXCEPTION 'jev rollback: feature_flags was lost'; END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1') THEN
  RAISE EXCEPTION 'jev rollback: the flag row was left behind';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_unlinked_rules_v1') THEN
  RAISE EXCEPTION 'jev rollback: another flag row was lost';
 END IF;
END $$;
