-- After the B-5 rollback: the lane list is the email reader's again, and the
-- functions and the read records table B-5 added are gone.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() WHERE cron_jobname='context-document-text')
 THEN RAISE EXCEPTION 'b5 rollback: lane list still names context-document-text'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure)<>'5c1e0e526a74d5b4ad612792c7f076cc'
 THEN RAISE EXCEPTION 'b5 rollback: lane list body'; END IF;
 IF has_function_privilege('anon','public.automation_switch_cron_lanes()','EXECUTE') THEN RAISE EXCEPTION 'b5 rollback: lane list grants'; END IF;
 IF to_regclass('public.context_document_texts') IS NOT NULL
  OR to_regprocedure('public.trigger_context_document_text()') IS NOT NULL
  OR to_regprocedure('public.record_context_document_text(jsonb)') IS NOT NULL
  OR to_regprocedure('public.context_document_text_due(integer)') IS NOT NULL
  OR to_regprocedure('public.context_document_text_sources()') IS NOT NULL
  OR to_regprocedure('public.context_document_text_status()') IS NOT NULL
  OR to_regprocedure('public.context_document_text_flag()') IS NOT NULL
  OR to_regprocedure('public.context_document_text_policy()') IS NOT NULL
 THEN RAISE EXCEPTION 'b5 rollback: objects left behind'; END IF;
END $$;
