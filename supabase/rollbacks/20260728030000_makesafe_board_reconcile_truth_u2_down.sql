-- Non-production rollback for SES Reporting U2 board reconciliation surfaces.
-- Operational jobs, substatuses, assignments, invoices and communications are
-- never touched.

DROP FUNCTION IF EXISTS public.apply_makesafe_board_reconciliation(
  text, text, text, jsonb
);
DROP VIEW IF EXISTS public.makesafe_board_attention_current;
DROP TRIGGER IF EXISTS trg_makesafe_board_reconciliation_runs_append_only
  ON public.makesafe_board_reconciliation_runs;
DROP TABLE IF EXISTS public.makesafe_board_reconciliation_runs;
DROP TRIGGER IF EXISTS trg_makesafe_board_attention_marks_append_only
  ON public.makesafe_board_attention_marks;
DROP TRIGGER IF EXISTS trg_makesafe_board_attention_marks_insert_guard
  ON public.makesafe_board_attention_marks;
DROP TABLE IF EXISTS public.makesafe_board_attention_marks;
DROP FUNCTION IF EXISTS public.reject_makesafe_board_attention_mark_mutation();
DROP FUNCTION IF EXISTS public.guard_makesafe_board_attention_mark_insert();

DROP FUNCTION IF EXISTS public.seed_makesafe_state_authority_v1(
  text, text, text, uuid[]
);
DROP VIEW IF EXISTS public.makesafe_state_identity_current_v2;
DROP TRIGGER IF EXISTS trg_makesafe_state_seed_runs_append_only
  ON public.makesafe_state_seed_runs;
DROP TABLE IF EXISTS public.makesafe_state_seed_runs;
DROP TRIGGER IF EXISTS trg_makesafe_state_identity_revisions_append_only
  ON public.makesafe_state_identity_revisions;
DROP TABLE IF EXISTS public.makesafe_state_identity_revisions;

DROP TRIGGER IF EXISTS trg_makesafe_source_authority_supersessions_state_v2
  ON public.makesafe_intake_source_authority_correction_supersessions;
DROP TRIGGER IF EXISTS trg_makesafe_source_authority_corrections_state_v2
  ON public.makesafe_intake_source_authority_corrections;
DROP TRIGGER IF EXISTS trg_makesafe_case_authority_corrections_state_v2
  ON public.makesafe_intake_case_authority_corrections;
DROP FUNCTION IF EXISTS public.refresh_makesafe_case_lineage_identity_v1();
DROP TRIGGER IF EXISTS trg_makesafe_intake_cases_stamp_state_v2
  ON public.makesafe_intake_cases;
DROP FUNCTION IF EXISTS public.stamp_makesafe_intake_case_identity_v1();

DROP TRIGGER IF EXISTS trg_makesafe_attendance_cycles_fact_identity_v1
  ON public.makesafe_attendance_cycles;
DROP TRIGGER IF EXISTS trg_job_assignments_fact_identity_v1
  ON public.job_assignments;
DROP TRIGGER IF EXISTS trg_job_service_reports_fact_identity_v1
  ON public.job_service_reports;
DROP TRIGGER IF EXISTS trg_job_documents_fact_identity_v1
  ON public.job_documents;
DROP TRIGGER IF EXISTS trg_job_media_fact_identity_v1
  ON public.job_media;
DROP TRIGGER IF EXISTS trg_makesafe_report_packs_fact_identity_v1
  ON public.makesafe_report_packs;
DROP FUNCTION IF EXISTS public.stamp_makesafe_fact_identity_v1();
DROP FUNCTION IF EXISTS public.makesafe_fact_hash_v1(text, jsonb);
DROP FUNCTION IF EXISTS public.reject_makesafe_state_seed_audit_mutation();

ALTER TABLE public.makesafe_cancellation_decisions
  DROP CONSTRAINT IF EXISTS makesafe_cancellation_evidence_refs_check;
ALTER TABLE public.makesafe_cancellation_decisions
  DROP COLUMN IF EXISTS evidence_refs;
