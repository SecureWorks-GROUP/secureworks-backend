-- After the Jev points rollback: the log, its three points' checks and the
-- agreement read exactly as 20261006080000 left them, the truth read gone, the
-- five switches gone, and every other flag row (the Jev shadow switch
-- included) untouched.
DO $$
DECLARE got text;
BEGIN
 IF to_regclass('public.context_jev_decisions') IS NULL THEN RAISE EXCEPTION 'jev points rollback: the log was lost'; END IF;
 IF to_regprocedure('public.context_jev_truth(public.context_jev_decisions)') IS NOT NULL THEN
  RAISE EXCEPTION 'jev points rollback: the truth read was left behind';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_jev_agreement(timestamptz,timestamptz)'))
    IS DISTINCT FROM '053b8b4a1b61dd2ba44a136ab1405ff5'
  OR coalesce(obj_description(to_regprocedure('public.context_jev_agreement(timestamptz,timestamptz)'), 'pg_proc'), '')
     NOT LIKE 'Context Jev decisions (20261006080000)%' THEN
  RAISE EXCEPTION 'jev points rollback: the agreement read is not 20261006080000''s';
 END IF;
 IF NOT has_function_privilege('service_role', 'public.context_jev_agreement(timestamptz,timestamptz)', 'EXECUTE')
  OR has_function_privilege('anon', 'public.context_jev_agreement(timestamptz,timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'jev points rollback: the agreement read''s access changed';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name LIKE 'context_jev_point_%') THEN
  RAISE EXCEPTION 'jev points rollback: a point''s switch was left behind';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1')
  OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_unlinked_rules_v1') THEN
  RAISE EXCEPTION 'jev points rollback: another flag row was lost';
 END IF;
 -- The restored checks refuse a new point's row and take an earlier point's.
 BEGIN
  INSERT INTO public.context_jev_decisions (decision_point, row_table, row_id, requested_model, model, jev_outcome, jev_confidence)
  VALUES ('sender_role', 'business_events', '0f000000-0000-4000-8000-0000000000e1', 'jev-1.13.0', 'jev-1.13.0', 'customer', 0.9);
  RAISE EXCEPTION 'jev points rollback: a sender_role row was taken';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.context_jev_decisions (decision_point, row_table, row_id, requested_model, model, jev_outcome, jev_confidence, current_outcome)
  VALUES ('placement', 'business_events', '0f000000-0000-4000-8000-0000000000e1', 'jev-1.13.0', 'jev-1.13.0', 'none', 0.9, 'none');
  RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'taken';
 EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
 END;
END $$;
