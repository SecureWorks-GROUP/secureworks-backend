-- Manual pre-cutover rollback for 20260720000001_makesafe_intake_cases.sql.
--
-- DO NOT run automatically. Production apply/rollback requires the Captain's
-- named G4 approval. This physical DROP is permitted only while every case is a
-- shadow record. Once any case is marked authoritative, rollback is the later
-- G5/G6 DB flag flip; the ledger remains inert evidence and physical removal is
-- a separately approved archive/rename operation.
--
-- Existing jobs, drafts, captured emails, attachments and events are untouched.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.makesafe_intake_cases') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.makesafe_intake_cases
      WHERE is_authoritative
    )
  THEN
    RAISE EXCEPTION
      'refusing post-cutover DROP: authoritative make-safe case evidence exists; use the pipeline flag rollback and archive separately';
  END IF;
END;
$$;

DROP VIEW IF EXISTS public.makesafe_intake_email_accounting;
DROP VIEW IF EXISTS public.makesafe_intake_case_divergence;
DROP TABLE IF EXISTS public.makesafe_intake_case_events;
DROP TABLE IF EXISTS public.makesafe_intake_case_sources;
DROP TABLE IF EXISTS public.makesafe_intake_cases;

DROP FUNCTION IF EXISTS public.record_makesafe_intake_case_event();
DROP FUNCTION IF EXISTS public.enforce_makesafe_intake_case_source_insert();
DROP FUNCTION IF EXISTS public.enforce_makesafe_intake_case_write();
DROP FUNCTION IF EXISTS public.reject_makesafe_intake_append_only_mutation();
DROP FUNCTION IF EXISTS public.makesafe_intake_case_transition_allowed(text, text);
DROP FUNCTION IF EXISTS public.makesafe_intake_provenance_valid(jsonb);
DROP FUNCTION IF EXISTS public.makesafe_intake_field_names_valid(text[]);

COMMIT;
