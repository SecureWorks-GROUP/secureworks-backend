-- Stuck read setup: every table and function this migration reads exists in the earlier registered
-- fixtures (jobs, job_documents, business_events, context_document_texts, context_capture_runs,
-- feature_flags, automation_switches). A check that the fixtures leave exactly production's pre-image
-- of the two bodies this migration replaces and the policy it reads (read from production 3 Nov 2026
-- 18:32Z, after 20261104130000), and no closer yet.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.record_context_document_text(jsonb)','c09711fa2928f366daecb41deed7e3ed'),
  ('public.context_document_text_status()','69cafa2747e11a63c10179195054865a'),
  ('public.context_document_text_policy()','e672da9e885bfbaeef5007c0cd756060')
 ) AS t(sig,md5) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'stuck setup: % is md5 %, not production''s pre-image %',x.sig,coalesce(live,'<missing>'),x.md5; END IF;
 END LOOP;
 IF to_regprocedure('public.close_stale_context_document_text_runs()') IS NOT NULL THEN RAISE EXCEPTION 'stuck setup: the closer exists before the migration'; END IF;
END $$;
