-- Non-production hard reverse for U2 Phase 1.
-- Production rollback is code/config rollback: leave additive audit data intact
-- and restore the prior edge version. Run this only on an empty validation DB.

DROP VIEW IF EXISTS public.makesafe_family_rules_current_v2;
DROP VIEW IF EXISTS public.makesafe_terminal_proofs_current_v2;
DROP VIEW IF EXISTS public.makesafe_cancellation_current_v2;
DROP VIEW IF EXISTS public.makesafe_revision_approvals_current_v2;
DROP VIEW IF EXISTS public.makesafe_readiness_current_v2;

DROP TRIGGER IF EXISTS trg_makesafe_intake_cases_readiness_invalidate
  ON public.makesafe_intake_cases;
DROP FUNCTION IF EXISTS public.invalidate_makesafe_case_dependency();
DROP TRIGGER IF EXISTS trg_makesafe_case_authority_readiness_invalidate
  ON public.makesafe_intake_case_authority_corrections;
DROP TRIGGER IF EXISTS trg_makesafe_source_authority_readiness_invalidate
  ON public.makesafe_intake_source_authority_corrections;
DROP TRIGGER IF EXISTS trg_makesafe_authority_supersession_readiness_invalidate
  ON public.makesafe_intake_source_authority_correction_supersessions;
DROP FUNCTION IF EXISTS public.invalidate_makesafe_authority_dependency();
DROP TRIGGER IF EXISTS trg_makesafe_family_pointer_readiness_invalidate
  ON public.makesafe_family_rule_current;
DROP FUNCTION IF EXISTS public.invalidate_makesafe_family_pointer();

DO $$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'makesafe_attendance_cycles',
    'job_assignments',
    'job_service_reports',
    'job_media',
    'job_documents',
    'makesafe_report_packs',
    'makesafe_report_pack_cycles',
    'makesafe_portal_capture_revisions'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON public.%I',
      'trg_' || relation_name || '_readiness_invalidate',
      relation_name
    );
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.invalidate_makesafe_fact_dependency();
DROP FUNCTION IF EXISTS public.commit_makesafe_readiness(
  uuid, bigint, text, text, text, jsonb, boolean, jsonb, text
);
DROP FUNCTION IF EXISTS public.invalidate_makesafe_readiness(
  uuid, text, text, text, text
);
DROP FUNCTION IF EXISTS public.makesafe_readiness_revision_v1(jsonb);
DROP FUNCTION IF EXISTS public.makesafe_attendance_cycle_set_hash_v1(uuid[]);
DROP FUNCTION IF EXISTS public.makesafe_canonical_json_v1(jsonb);

DROP TABLE IF EXISTS public.makesafe_terminal_proofs;
DROP TABLE IF EXISTS public.makesafe_cancellation_decisions;
DROP TABLE IF EXISTS public.makesafe_revision_approvals;
DROP TABLE IF EXISTS public.makesafe_readiness_invalidations;
DROP TABLE IF EXISTS public.makesafe_readiness_current;
DROP TABLE IF EXISTS public.makesafe_readiness_revisions;
DROP TABLE IF EXISTS public.makesafe_portal_capture_revisions;
DROP TABLE IF EXISTS public.makesafe_family_rule_current;
DROP TABLE IF EXISTS public.makesafe_family_rule_revisions;
DROP TABLE IF EXISTS public.makesafe_state_projection_config;
DROP FUNCTION IF EXISTS public.reject_makesafe_state_audit_mutation();

ALTER TABLE public.makesafe_status_holds
  DROP COLUMN IF EXISTS blocker_code,
  DROP COLUMN IF EXISTS owner_role,
  DROP COLUMN IF EXISTS recovery_action,
  DROP COLUMN IF EXISTS recovery_instruction,
  DROP COLUMN IF EXISTS evidence_refs,
  DROP COLUMN IF EXISTS blocker_source;
ALTER TABLE public.makesafe_report_packs
  DROP COLUMN IF EXISTS makesafe_fact_version,
  DROP COLUMN IF EXISTS makesafe_content_hash;
ALTER TABLE public.job_documents
  DROP COLUMN IF EXISTS attendance_cycle_id,
  DROP COLUMN IF EXISTS cycle_attribution,
  DROP COLUMN IF EXISTS makesafe_fact_version,
  DROP COLUMN IF EXISTS makesafe_content_hash;
ALTER TABLE public.job_media
  DROP COLUMN IF EXISTS attendance_cycle_id,
  DROP COLUMN IF EXISTS cycle_attribution,
  DROP COLUMN IF EXISTS makesafe_fact_version,
  DROP COLUMN IF EXISTS makesafe_content_hash;
ALTER TABLE public.job_service_reports
  DROP COLUMN IF EXISTS makesafe_fact_version,
  DROP COLUMN IF EXISTS makesafe_content_hash;
ALTER TABLE public.job_assignments
  DROP COLUMN IF EXISTS makesafe_fact_version,
  DROP COLUMN IF EXISTS makesafe_content_hash;
ALTER TABLE public.makesafe_attendance_cycles
  DROP COLUMN IF EXISTS makesafe_fact_version,
  DROP COLUMN IF EXISTS makesafe_content_hash;
ALTER TABLE public.makesafe_intake_cases
  DROP COLUMN IF EXISTS source_version,
  DROP COLUMN IF EXISTS source_content_hash,
  DROP COLUMN IF EXISTS lineage_version,
  DROP COLUMN IF EXISTS lineage_correction_hash,
  DROP COLUMN IF EXISTS lineage_supersession_hash;
