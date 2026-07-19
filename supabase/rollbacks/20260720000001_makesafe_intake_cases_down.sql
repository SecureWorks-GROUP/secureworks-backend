-- Manual rollback for 20260720000001_makesafe_intake_cases.sql.
--
-- DO NOT run automatically. Applying or rolling back the production migration
-- requires the Captain's named G4 approval. Before rollback, export all five
-- tables if any adapter or operator has written case data. This script does not
-- touch jobs, make-safe intake drafts, captured emails, attachments or events.

BEGIN;

DROP TABLE IF EXISTS public.makesafe_intake_case_lineage;
DROP TABLE IF EXISTS public.makesafe_intake_case_attachments;
DROP TABLE IF EXISTS public.makesafe_intake_case_sources;
DROP TABLE IF EXISTS public.makesafe_intake_case_transitions;
DROP TABLE IF EXISTS public.makesafe_intake_cases;

DROP FUNCTION IF EXISTS public.enforce_makesafe_intake_case_lineage();
DROP FUNCTION IF EXISTS public.reject_makesafe_intake_append_only_mutation();
DROP FUNCTION IF EXISTS public.record_makesafe_intake_case_transition();
DROP FUNCTION IF EXISTS public.enforce_makesafe_intake_case_write();
DROP FUNCTION IF EXISTS public.makesafe_intake_case_transition_allowed(text, text);
DROP FUNCTION IF EXISTS public.makesafe_intake_identity_provenance_valid(jsonb);
DROP FUNCTION IF EXISTS public.makesafe_intake_field_names_valid(text[]);

COMMIT;
