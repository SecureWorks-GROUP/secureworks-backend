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
 IF to_regprocedure('public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, jsonb)') IS NOT NULL
    OR to_regprocedure('public.quote_acceptance_fingerprint(uuid)') IS NOT NULL
    OR to_regprocedure('public.quote_acceptance_snapshot(uuid)') IS NOT NULL
    OR to_regprocedure('public.quote_acceptance_handler_finished(uuid, uuid)') IS NOT NULL
    OR to_regprocedure('public.quote_acceptance_gaps(interval)') IS NOT NULL THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: a function still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags
             WHERE flag_name IN ('quote_accept_atomic_v1', 'quote_option_strict_record_v1')) THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: a switch row still exists';
 END IF;
 IF to_regprocedure('public.jobs_quote_option_supersede()') IS NULL THEN
  RAISE EXCEPTION 'quote accept atomic rollback contract: the supersede trigger function must remain';
 END IF;
END $$;
