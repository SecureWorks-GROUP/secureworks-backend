-- Rollback contract: 20261019230000_quote_accept_atomic. The down drops the attempt table,
-- every function and both switch rows; the supersede trigger then reads the strict switch as
-- missing, which is off.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.quote_acceptance_attempts') IS NOT NULL THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: the attempt table still exists';
 END IF;
 IF to_regclass('public.quote_acceptance_gap_resolutions') IS NOT NULL THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: the resolutions table still exists';
 END IF;
 IF to_regprocedure('public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, uuid, jsonb)') IS NOT NULL
    OR to_regprocedure('public.quote_acceptance_fingerprint(uuid)') IS NOT NULL
    OR to_regprocedure('public.quote_acceptance_snapshot(uuid, text)') IS NOT NULL
    OR to_regprocedure('public.quote_acceptance_handler_finished(uuid, uuid, text)') IS NOT NULL
    OR to_regprocedure('public.quote_acceptance_gaps(interval, timestamptz)') IS NOT NULL
    OR to_regprocedure('public.quote_accept_legacy_set_status(uuid, text, timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: a function still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags
             WHERE flag_name IN ('quote_accept_atomic_v1', 'quote_option_strict_record_v1')) THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: a switch row still exists';
 END IF;
 IF to_regprocedure('public.jobs_quote_option_supersede()') IS NULL THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: the supersede trigger function must remain';
 END IF;

 -- Nothing beyond this migration's own objects is touched (rollback mutants m12 to m19).
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_jobs_quote_option_supersede'
                 AND tgrelid = 'public.jobs'::regclass AND NOT tgisinternal
                 AND tgenabled <> 'D'
                 AND tgfoid = 'public.jobs_quote_option_supersede()'::regprocedure) THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: the supersede trigger must remain, enabled and bound to its function';
 END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name IN ('quote_option_supersede_v1', 'fence_same_site_guard_v1')
       AND enabled = false) <> 2 THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: the other switches must remain, off';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs'
                 AND column_name = 'accepted_at') THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: jobs.accepted_at must remain';
 END IF;
 IF (SELECT status = 'accepted' AND accepted_at = '2026-10-01 00:00:00+00' FROM public.jobs
      WHERE id = '9e9e0000-0000-4000-8000-000000000001') IS NOT TRUE
    OR (SELECT accepted_at = '2026-10-01 00:00:00+00' FROM public.job_documents
         WHERE id = '9e9e0000-0000-4000-8000-0000000000d1') IS NOT TRUE
    OR NOT EXISTS (SELECT 1 FROM public.job_events WHERE id = '9e9e0000-0000-4000-8000-0000000000e1'
                    AND event_type = 'quote_accepted') THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: an acceptance committed before the down must survive it';
 END IF;
 -- Owned objects are found by name prefix (underscore escaped) in public, and by the
 -- 'SQ-23 remedy:' comment every one of them carries, so a renamed one is still found.
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND (c.relname LIKE 'quote\_acceptance\_%' ESCAPE '\'
                    OR obj_description(c.oid, 'pg_class') LIKE 'SQ-23 remedy:%')) THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: a relation of this migration remains (renamed or left)';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND (p.proname IN ('accept_quote_document_atomic', 'quote_acceptance_fingerprint',
                                  'quote_acceptance_snapshot', 'quote_acceptance_handler_finished', 'quote_acceptance_gaps',
                                  'quote_accept_legacy_set_status')
                    OR obj_description(p.oid, 'pg_proc') LIKE 'SQ-23 remedy:%')) THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: a function of this migration remains, in some overload or renamed';
 END IF;
END $$;
