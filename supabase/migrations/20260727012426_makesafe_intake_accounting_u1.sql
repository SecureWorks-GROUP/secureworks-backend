-- SES reporting U1: cancellation targets, typed source issues, and deterministic
-- legacy-draft accounting. This migration is schema/audit only: it creates no
-- jobs, changes no job state, sends nothing, and invokes no intake runtime.

ALTER TABLE public.makesafe_intake_cases
  ADD COLUMN IF NOT EXISTS target_relation text,
  ADD COLUMN IF NOT EXISTS target_job_id uuid
    REFERENCES public.jobs(id) ON DELETE RESTRICT;

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_target_relation_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_target_relation_check CHECK (
    target_relation IS NULL
    OR target_relation IN ('cancellation_of', 'revision_of', 'reopen_of')
  );

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_target_job_relation_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_target_job_relation_check CHECK (
    target_job_id IS NULL OR target_relation IS NOT NULL
  );

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_parent_target_relation_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_parent_target_relation_check CHECK (
    target_relation IS NULL
    OR parent_relation IS NULL
    OR parent_relation = target_relation
  );

CREATE OR REPLACE FUNCTION public.validate_makesafe_intake_target_job()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.target_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.jobs j
    WHERE j.id = NEW.target_job_id
      AND j.org_id = NEW.org_id
      AND j.type = 'makesafe'
  ) THEN
    RAISE EXCEPTION
      'intake target job must be a make-safe in the same organisation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_makesafe_intake_target_job()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_makesafe_intake_target_job()
  TO service_role, postgres;

DROP TRIGGER IF EXISTS trg_makesafe_intake_target_job
  ON public.makesafe_intake_cases;
CREATE TRIGGER trg_makesafe_intake_target_job
  BEFORE INSERT OR UPDATE OF org_id, target_job_id
  ON public.makesafe_intake_cases
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_makesafe_intake_target_job();

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_reason_code_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_reason_code_check CHECK (reason_code IN (
    'cancellation',
    'cancellation_target_not_found',
    'cancellation_target_ambiguous',
    'cancellation_live_invoice_review',
    'cancellation_target_terminal_conflict',
    'cancellation_apply_failed',
    'duplicate',
    'revision',
    'unknown_builder',
    'non_makesafe',
    'ambiguous_scope',
    'below_identity_floor',
    'adapter_parse_failure',
    'conflicting_fields',
    'awaiting_job_creation'
  ));

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_cases_target_job
  ON public.makesafe_intake_cases (org_id, target_job_id)
  WHERE target_job_id IS NOT NULL;

ALTER TABLE public.email_events_raw
  ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL
  DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES public.organisations(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.email_events_raw
    WHERE change_type LIKE 'intake\_%' ESCAPE '\'
    GROUP BY org_id, post_id, change_type
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate intake source issues exist; review them before applying U1';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_events_raw_intake_issue
  ON public.email_events_raw (org_id, post_id, change_type)
  WHERE change_type LIKE 'intake\_%' ESCAPE '\';

ALTER TABLE public.makesafe_intake_drafts
  ADD COLUMN IF NOT EXISTS deterministic_case_id uuid;

ALTER TABLE public.makesafe_intake_drafts
  DROP CONSTRAINT IF EXISTS makesafe_intake_drafts_deterministic_case_fk;
ALTER TABLE public.makesafe_intake_drafts
  ADD CONSTRAINT makesafe_intake_drafts_deterministic_case_fk
  FOREIGN KEY (org_id, deterministic_case_id)
  REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT;

UPDATE public.makesafe_intake_drafts
SET status = 'rejected',
    updated_at = now()
WHERE rejected_at IS NOT NULL
  AND status <> 'rejected';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_intake_drafts
    WHERE status = 'rejected'
      AND rejected_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'rejected intake drafts without rejection evidence require review';
  END IF;
END
$$;

ALTER TABLE public.makesafe_intake_drafts
  DROP CONSTRAINT IF EXISTS makesafe_intake_drafts_rejected_at_status_check;
ALTER TABLE public.makesafe_intake_drafts
  ADD CONSTRAINT makesafe_intake_drafts_rejected_at_status_check CHECK (
    rejected_at IS NULL OR status = 'rejected'
  );

ALTER TABLE public.makesafe_intake_drafts
  DROP CONSTRAINT IF EXISTS makesafe_intake_drafts_rejected_status_evidence_check;
ALTER TABLE public.makesafe_intake_drafts
  ADD CONSTRAINT makesafe_intake_drafts_rejected_status_evidence_check CHECK (
    status <> 'rejected' OR rejected_at IS NOT NULL
  );

COMMENT ON COLUMN public.makesafe_intake_cases.target_job_id IS
  'Existing job targeted by a cancellation/revision/reopen; never the case-owned job.';
COMMENT ON COLUMN public.makesafe_intake_drafts.deterministic_case_id IS
  'Canonical case/fate that supersedes or accounts this legacy extraction draft.';
