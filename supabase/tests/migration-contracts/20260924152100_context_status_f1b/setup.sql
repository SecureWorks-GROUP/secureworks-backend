-- F1b setup. Earlier registered fixtures already supply every table F1b reads:
-- business_events (F1 and the context fixtures), context_capture_runs (F1),
-- feature_flags (C1d, live shape, no ghl_call_transcript_fetch_v1 row, as in
-- production) and automation_switches. No extra columns.
--
-- Prove the fixtures leave exactly the pre-image the migration's guard pins,
-- so the contract below runs against production's starting point: the F1
-- bodies of the four functions F1b replaces, F1's twelve capture-run columns,
-- and none of the four new stubs.
DO $$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_pipeline_status()','6f78816a6f676cd9a28f6271d2c6c8e0'),
  ('public.context_source_freshness()','ce094feb8df8b7dd596e639ac47a7825'),
  ('public.context_source_freshness_policy()','230c0b1965208474fc6ea076e5dd3f6f'),
  ('public.record_capture_run(jsonb)','a85b48f9422fff111ee96093bad55c40')) AS t(sig,md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.md5
  THEN RAISE EXCEPTION 'f1b setup: % is not the production pre-image',x.sig; END IF;
 END LOOP;
 IF to_regprocedure('public.context_email_capture_status()') IS NOT NULL OR to_regprocedure('public.context_transcript_capture_status()') IS NOT NULL
  OR to_regprocedure('public.context_money_status()') IS NOT NULL OR to_regprocedure('public.context_bucket_status()') IS NOT NULL
 THEN RAISE EXCEPTION 'f1b setup: a new stub already exists'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_capture_runs'::regclass AND attname='window_end_id' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'f1b setup: window_end_id already exists'; END IF;
 IF to_regclass('public.feature_flags') IS NULL OR EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='ghl_call_transcript_fetch_v1')
 THEN RAISE EXCEPTION 'f1b setup: feature_flags missing or already holds ghl_call_transcript_fetch_v1'; END IF;
END $$;
