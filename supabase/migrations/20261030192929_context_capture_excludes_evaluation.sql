-- CTX-T5/F1: AI canary results are not a business-message capture lane.
-- Exact-body guards preserve privileges, owner, search path and other policy.
-- No events, schedules, flags, evaluation inputs or financial data are changed.
DO $patch$ DECLARE f text; h text; BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 SELECT pg_get_functiondef(oid),md5(prosrc) INTO f,h FROM pg_proc WHERE oid=to_regprocedure('public.context_source_freshness_policy()');
 IF h IS DISTINCT FROM '9c9eec29e52243e4eac45d37322d2002' THEN
  IF h IS DISTINCT FROM '0b131a763a53c21811465e04a66be539' THEN RAISE EXCEPTION 'capture_evaluation_preimage_mismatch: public.context_source_freshness_policy()'; END IF;
  EXECUTE replace(f,$before$'ignored_capture_modes',jsonb_build_array('backfill','relink'),$before$,$after$'ignored_capture_modes',jsonb_build_array('backfill','relink'),
  -- AI evaluation records are not captured business messages. Exclude by row
  -- type, not source, so mixed writers still reveal stopped business capture.
  'ignored_capture_event_types',jsonb_build_array('ai.canary_result'),$after$);
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_source_freshness_policy()')) IS DISTINCT FROM '9c9eec29e52243e4eac45d37322d2002'
 THEN RAISE EXCEPTION 'capture_evaluation_postimage_mismatch: public.context_source_freshness_policy()'; END IF;
 SELECT pg_get_functiondef(oid),md5(prosrc) INTO f,h FROM pg_proc WHERE oid=to_regprocedure('public.context_source_freshness()');
 IF h IS DISTINCT FROM '2bc4f9800684f05402081dea2680498b' THEN
  IF h IS DISTINCT FROM '474f94e13b3be83ffe7ce6c4f5b2d774' THEN RAISE EXCEPTION 'capture_evaluation_preimage_mismatch: public.context_source_freshness()'; END IF;
  EXECUTE replace(f,$before$   AND coalesce(e.metadata->>'capture_mode','live') NOT IN (SELECT jsonb_array_elements_text(policy->'ignored_capture_modes'))$before$,$after$   AND coalesce(e.metadata->>'capture_mode','live') NOT IN (SELECT jsonb_array_elements_text(policy->'ignored_capture_modes'))
   AND coalesce(e.event_type,'') NOT IN (SELECT jsonb_array_elements_text(policy->'ignored_capture_event_types'))$after$);
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_source_freshness()')) IS DISTINCT FROM '2bc4f9800684f05402081dea2680498b'
 THEN RAISE EXCEPTION 'capture_evaluation_postimage_mismatch: public.context_source_freshness()'; END IF;
END $patch$;
