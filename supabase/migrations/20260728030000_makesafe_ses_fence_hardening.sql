-- Wave-2 SES fence hardening.
--
-- This migration is additive and performs no Xero, Graph, email, SMS, invoice,
-- or job-state effect. It makes the SES classification durable and adds the
-- local approval/ledger authority used by the SES-native void action.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS ses_money_sealed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ses_money_seal_source text,
  ADD COLUMN IF NOT EXISTS ses_money_seal_version integer;

ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_ses_money_seal_complete;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_ses_money_seal_complete CHECK (
    (ses_money_sealed_at IS NULL
      AND ses_money_seal_source IS NULL
      AND ses_money_seal_version IS NULL)
    OR
    (ses_money_sealed_at IS NOT NULL
      AND length(btrim(ses_money_seal_source)) > 0
      AND ses_money_seal_version = 1)
  );

CREATE OR REPLACE FUNCTION public.guard_jobs_ses_money_seal_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Once present, this refuses any clear or mutation of the seal identity.
  IF TG_OP = 'UPDATE'
     AND OLD.ses_money_sealed_at IS NOT NULL
     AND (
       NEW.ses_money_sealed_at IS DISTINCT FROM OLD.ses_money_sealed_at
       OR NEW.ses_money_seal_source IS DISTINCT FROM OLD.ses_money_seal_source
       OR NEW.ses_money_seal_version IS DISTINCT FROM OLD.ses_money_seal_version
     ) THEN
    RAISE EXCEPTION 'the SES money seal is write-once and cannot be cleared or mutated'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.ses_money_sealed_at IS NULL
     AND (
       lower(regexp_replace(COALESCE(NEW.type, ''), '[[:space:]_-]+', '', 'g'))
         = 'makesafe'
       OR COALESCE(NEW.job_number, '') ~* '^SWMS-'
     ) THEN
    NEW.ses_money_sealed_at := clock_timestamp();
    NEW.ses_money_seal_source := 'job_spine';
    NEW.ses_money_seal_version := 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_ses_money_seal_v1 ON public.jobs;
CREATE TRIGGER trg_jobs_ses_money_seal_v1
  BEFORE INSERT OR UPDATE OF
    type, job_number, ses_money_sealed_at, ses_money_seal_source,
    ses_money_seal_version
  ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_jobs_ses_money_seal_v1();

CREATE OR REPLACE FUNCTION public.seal_makesafe_job_v1(
  p_job_id uuid,
  p_source text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_job_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.jobs
  SET
    ses_money_sealed_at = clock_timestamp(),
    ses_money_seal_source = COALESCE(NULLIF(btrim(p_source), ''), 'canonical_spine'),
    ses_money_seal_version = 1
  WHERE id = p_job_id
    AND ses_money_sealed_at IS NULL;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM public.jobs WHERE id = p_job_id
  ) THEN
    RAISE EXCEPTION 'cannot seal missing SES job %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.seal_makesafe_child_job_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seal_makesafe_job_v1(NEW.job_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seal_makesafe_case_jobs_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seal_makesafe_job_v1(NEW.job_id, 'makesafe_intake_cases.job_id');
  PERFORM public.seal_makesafe_job_v1(
    NEW.target_job_id,
    'makesafe_intake_cases.target_job_id'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_makesafe_details_seal_job
  ON public.makesafe_job_details;
CREATE TRIGGER trg_makesafe_details_seal_job
  AFTER INSERT OR UPDATE OF job_id ON public.makesafe_job_details
  FOR EACH ROW EXECUTE FUNCTION public.seal_makesafe_child_job_v1();

DROP TRIGGER IF EXISTS trg_makesafe_cycles_seal_job
  ON public.makesafe_attendance_cycles;
CREATE TRIGGER trg_makesafe_cycles_seal_job
  AFTER INSERT OR UPDATE OF job_id ON public.makesafe_attendance_cycles
  FOR EACH ROW EXECUTE FUNCTION public.seal_makesafe_child_job_v1();

DROP TRIGGER IF EXISTS trg_makesafe_dockets_seal_job
  ON public.makesafe_docket_revisions;
CREATE TRIGGER trg_makesafe_dockets_seal_job
  AFTER INSERT OR UPDATE OF job_id ON public.makesafe_docket_revisions
  FOR EACH ROW EXECUTE FUNCTION public.seal_makesafe_child_job_v1();

DROP TRIGGER IF EXISTS trg_makesafe_obligations_seal_job
  ON public.makesafe_invoice_obligations;
CREATE TRIGGER trg_makesafe_obligations_seal_job
  AFTER INSERT OR UPDATE OF job_id ON public.makesafe_invoice_obligations
  FOR EACH ROW EXECUTE FUNCTION public.seal_makesafe_child_job_v1();

DROP TRIGGER IF EXISTS trg_makesafe_obligation_revisions_seal_job
  ON public.makesafe_invoice_obligation_revisions;
CREATE TRIGGER trg_makesafe_obligation_revisions_seal_job
  AFTER INSERT OR UPDATE OF job_id
  ON public.makesafe_invoice_obligation_revisions
  FOR EACH ROW EXECUTE FUNCTION public.seal_makesafe_child_job_v1();

DROP TRIGGER IF EXISTS trg_makesafe_intake_cases_seal_jobs
  ON public.makesafe_intake_cases;
CREATE TRIGGER trg_makesafe_intake_cases_seal_jobs
  AFTER INSERT OR UPDATE OF job_id, target_job_id
  ON public.makesafe_intake_cases
  FOR EACH ROW EXECUTE FUNCTION public.seal_makesafe_case_jobs_v1();

WITH canonical_jobs AS (
  SELECT id AS job_id, 'job_spine_backfill'::text AS source
  FROM public.jobs
  WHERE lower(regexp_replace(COALESCE(type, ''), '[[:space:]_-]+', '', 'g'))
          = 'makesafe'
     OR COALESCE(job_number, '') ~* '^SWMS-'
  UNION
  SELECT job_id, 'makesafe_job_details_backfill'
  FROM public.makesafe_job_details
  UNION
  SELECT job_id, 'makesafe_attendance_cycles_backfill'
  FROM public.makesafe_attendance_cycles
  UNION
  SELECT job_id, 'makesafe_docket_revisions_backfill'
  FROM public.makesafe_docket_revisions
  UNION
  SELECT job_id, 'makesafe_invoice_obligations_backfill'
  FROM public.makesafe_invoice_obligations
  UNION
  SELECT job_id, 'makesafe_invoice_obligation_revisions_backfill'
  FROM public.makesafe_invoice_obligation_revisions
  UNION
  SELECT job_id, 'makesafe_intake_cases_job_backfill'
  FROM public.makesafe_intake_cases
  WHERE job_id IS NOT NULL
  UNION
  SELECT target_job_id, 'makesafe_intake_cases_target_backfill'
  FROM public.makesafe_intake_cases
  WHERE target_job_id IS NOT NULL
)
UPDATE public.jobs AS j
SET
  ses_money_sealed_at = clock_timestamp(),
  ses_money_seal_source = canonical.source,
  ses_money_seal_version = 1
FROM (
  SELECT DISTINCT ON (job_id) job_id, source
  FROM canonical_jobs
  WHERE job_id IS NOT NULL
  ORDER BY job_id, source
) AS canonical
WHERE j.id = canonical.job_id
  AND j.ses_money_sealed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_ses_money_sealed
  ON public.jobs (ses_money_sealed_at, id)
  WHERE ses_money_sealed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.makesafe_invoice_void_revisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  xero_invoice_id text NOT NULL,
  invoice_obligation_revision_id uuid
    REFERENCES public.makesafe_invoice_obligation_revisions(id)
    ON DELETE RESTRICT,
  observed_status text NOT NULL,
  target_status text NOT NULL CHECK (target_status IN ('DELETED', 'VOIDED')),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'proposed' CHECK (
    state IN ('proposed', 'approved', 'executing', 'confirmed', 'superseded')
  ),
  provider_digest jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(provider_digest) = 'object'),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  UNIQUE (org_id, xero_invoice_id, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_invoice_void_active
  ON public.makesafe_invoice_void_revisions (org_id, xero_invoice_id)
  WHERE state IN ('proposed', 'approved', 'executing');

CREATE OR REPLACE FUNCTION public.guard_makesafe_invoice_void_content_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.xero_invoice_id IS DISTINCT FROM OLD.xero_invoice_id
     OR NEW.invoice_obligation_revision_id IS DISTINCT FROM
       OLD.invoice_obligation_revision_id
     OR NEW.observed_status IS DISTINCT FROM OLD.observed_status
     OR NEW.target_status IS DISTINCT FROM OLD.target_status
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SES invoice void content is immutable; prepare a new revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_makesafe_invoice_void_content_immutable
  ON public.makesafe_invoice_void_revisions;
CREATE TRIGGER trg_makesafe_invoice_void_content_immutable
  BEFORE UPDATE ON public.makesafe_invoice_void_revisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_makesafe_invoice_void_content_v1();

CREATE TABLE IF NOT EXISTS public.makesafe_invoice_void_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  void_revision_id uuid NOT NULL
    REFERENCES public.makesafe_invoice_void_revisions(id) ON DELETE RESTRICT,
  approval_content_hash text NOT NULL
    CHECK (approval_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  decided_by text NOT NULL CHECK (length(btrim(decided_by)) > 0),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (void_revision_id, approval_content_hash)
);

DROP TRIGGER IF EXISTS trg_makesafe_invoice_void_approvals_append_only
  ON public.makesafe_invoice_void_approvals;
CREATE TRIGGER trg_makesafe_invoice_void_approvals_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_invoice_void_approvals
  FOR EACH ROW EXECUTE FUNCTION public.reject_ses_append_only_change();

CREATE OR REPLACE FUNCTION public.commit_ses_invoice_void_revision_v1(
  p_id uuid,
  p_org_id uuid,
  p_job_id uuid,
  p_xero_invoice_id text,
  p_invoice_obligation_revision_id uuid,
  p_observed_status text,
  p_target_status text,
  p_reason text,
  p_content_hash text,
  p_created_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing public.makesafe_invoice_void_revisions%ROWTYPE;
  committed public.makesafe_invoice_void_revisions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'ses-invoice-void-prepare:' || p_org_id::text || ':' || p_xero_invoice_id,
      0
    )
  );

  SELECT * INTO existing
  FROM public.makesafe_invoice_void_revisions
  WHERE id = p_id
  FOR UPDATE;
  IF FOUND THEN
    IF existing.org_id IS DISTINCT FROM p_org_id
       OR existing.job_id IS DISTINCT FROM p_job_id
       OR existing.xero_invoice_id IS DISTINCT FROM p_xero_invoice_id
       OR existing.invoice_obligation_revision_id IS DISTINCT FROM
         p_invoice_obligation_revision_id
       OR existing.observed_status IS DISTINCT FROM p_observed_status
       OR existing.target_status IS DISTINCT FROM p_target_status
       OR existing.reason IS DISTINCT FROM p_reason
       OR existing.content_hash IS DISTINCT FROM p_content_hash THEN
      RAISE EXCEPTION 'the content-addressed SES void revision does not match'
        USING ERRCODE = '23514';
    END IF;
    RETURN to_jsonb(existing);
  END IF;

  PERFORM 1
  FROM public.xero_invoices AS xi
  JOIN public.jobs AS j ON j.id = xi.job_id
  WHERE xi.org_id = p_org_id
    AND xi.xero_invoice_id = p_xero_invoice_id
    AND xi.invoice_type = 'ACCREC'
    AND xi.job_id = p_job_id
    AND xi.status = p_observed_status
    AND j.ses_money_sealed_at IS NOT NULL
    AND (
      (p_observed_status = 'DRAFT' AND p_target_status = 'DELETED')
      OR
      (p_observed_status IN ('SUBMITTED', 'AUTHORISED')
        AND p_target_status = 'VOIDED')
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the sealed ACCREC invoice binding or void target is not authoritative'
      USING ERRCODE = '40001';
  END IF;

  SELECT * INTO existing
  FROM public.makesafe_invoice_void_revisions
  WHERE org_id = p_org_id
    AND xero_invoice_id = p_xero_invoice_id
    AND state IN ('proposed', 'approved', 'executing')
  FOR UPDATE;
  IF FOUND THEN
    IF existing.state <> 'proposed' THEN
      RAISE EXCEPTION 'an approved or executing SES void revision already owns this invoice'
        USING ERRCODE = '40001';
    END IF;
    UPDATE public.makesafe_invoice_void_revisions
    SET state = 'superseded', updated_at = clock_timestamp()
    WHERE id = existing.id;
  END IF;

  INSERT INTO public.makesafe_invoice_void_revisions (
    id,
    org_id,
    job_id,
    xero_invoice_id,
    invoice_obligation_revision_id,
    observed_status,
    target_status,
    reason,
    content_hash,
    state,
    created_by
  ) VALUES (
    p_id,
    p_org_id,
    p_job_id,
    p_xero_invoice_id,
    p_invoice_obligation_revision_id,
    p_observed_status,
    p_target_status,
    p_reason,
    p_content_hash,
    'proposed',
    p_created_by
  )
  RETURNING * INTO committed;
  RETURN to_jsonb(committed);
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_ses_invoice_void_revision_v1(
  p_void_revision_id uuid,
  p_content_hash text,
  p_decided_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.makesafe_invoice_void_revisions%ROWTYPE;
  approval public.makesafe_invoice_void_approvals%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-invoice-void-approval:' || p_void_revision_id::text, 0)
  );
  SELECT * INTO target
  FROM public.makesafe_invoice_void_revisions
  WHERE id = p_void_revision_id
  FOR UPDATE;
  IF NOT FOUND
     OR target.content_hash IS DISTINCT FROM p_content_hash
     OR target.state NOT IN ('proposed', 'approved') THEN
    RAISE EXCEPTION 'the exact proposed SES invoice void revision is unavailable'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.makesafe_invoice_void_approvals (
    void_revision_id,
    approval_content_hash,
    decided_by
  ) VALUES (
    target.id,
    target.content_hash,
    p_decided_by
  )
  ON CONFLICT (void_revision_id, approval_content_hash) DO NOTHING
  RETURNING * INTO approval;
  IF NOT FOUND THEN
    SELECT * INTO approval
    FROM public.makesafe_invoice_void_approvals
    WHERE void_revision_id = target.id
      AND approval_content_hash = target.content_hash;
  END IF;

  UPDATE public.makesafe_invoice_void_revisions
  SET state = 'approved', updated_at = clock_timestamp()
  WHERE id = target.id AND state = 'proposed'
  RETURNING * INTO target;
  IF NOT FOUND THEN
    SELECT * INTO target
    FROM public.makesafe_invoice_void_revisions
    WHERE id = p_void_revision_id;
  END IF;
  RETURN jsonb_build_object(
    'revision', to_jsonb(target),
    'approval', to_jsonb(approval)
  );
END;
$$;

ALTER TABLE public.ses_external_effects
  DROP CONSTRAINT IF EXISTS ses_external_effects_effect_kind_check;
ALTER TABLE public.ses_external_effects
  ADD CONSTRAINT ses_external_effects_effect_kind_check CHECK (
    effect_kind IN (
      'invoice_create',
      'invoice_authorise',
      'invoice_void',
      'route_send',
      'document_store'
    )
  );

ALTER TABLE public.ses_external_effects
  DROP CONSTRAINT IF EXISTS ses_external_effect_shape;
ALTER TABLE public.ses_external_effects
  ADD CONSTRAINT ses_external_effect_shape CHECK (
    (effect_kind = 'invoice_create'
      AND invoice_obligation_revision_id IS NOT NULL
      AND release_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'invoice_authorise'
      AND invoice_obligation_revision_id IS NOT NULL
      AND release_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'invoice_void'
      AND job_id IS NOT NULL
      AND artifact_hash IS NOT NULL
      AND release_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'route_send'
      AND release_revision_id IS NOT NULL
      AND route_kind IS NOT NULL)
    OR (effect_kind = 'document_store'
      AND docket_revision_id IS NOT NULL
      AND artifact_hash IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_invoice_void
  ON public.ses_external_effects (artifact_hash)
  WHERE effect_kind = 'invoice_void';

CREATE OR REPLACE FUNCTION public.begin_ses_invoice_void_execution_v1(
  p_void_revision_id uuid,
  p_content_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.makesafe_invoice_void_revisions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-invoice-void:' || p_void_revision_id::text, 0)
  );
  SELECT * INTO target
  FROM public.makesafe_invoice_void_revisions
  WHERE id = p_void_revision_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the approved SES invoice void revision no longer exists'
      USING ERRCODE = 'P0002';
  END IF;
  IF target.content_hash IS DISTINCT FROM p_content_hash THEN
    RAISE EXCEPTION 'the displayed void content no longer matches the stored revision'
      USING ERRCODE = '23514';
  END IF;
  IF target.state NOT IN ('approved', 'executing', 'confirmed') THEN
    RAISE EXCEPTION 'human SES void approval is missing'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
  FROM public.makesafe_invoice_void_approvals
  WHERE void_revision_id = target.id
    AND approval_content_hash = target.content_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the exact SES void approval is missing'
      USING ERRCODE = '42501';
  END IF;
  IF target.state = 'confirmed' THEN
    PERFORM 1
    FROM public.xero_invoices
    WHERE org_id = target.org_id
      AND xero_invoice_id = target.xero_invoice_id
      AND job_id = target.job_id
      AND invoice_type = 'ACCREC'
      AND status = target.target_status;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the confirmed SES void no longer matches the invoice mirror'
        USING ERRCODE = '40001';
    END IF;
  ELSE
    PERFORM 1
    FROM public.xero_invoices
    WHERE org_id = target.org_id
      AND xero_invoice_id = target.xero_invoice_id
      AND job_id = target.job_id
      AND invoice_type = 'ACCREC'
      AND (
        status = target.observed_status
        OR (target.state = 'executing' AND status = target.target_status)
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the invoice mirror binding or status changed; prepare a new void revision'
        USING ERRCODE = '40001';
    END IF;
    UPDATE public.makesafe_invoice_void_revisions
    SET state = 'executing', updated_at = clock_timestamp()
    WHERE id = target.id AND state = 'approved';
  END IF;
  RETURN jsonb_build_object(
    'void_revision_id', target.id,
    'job_id', target.job_id,
    'xero_invoice_id', target.xero_invoice_id,
    'target_status', target.target_status,
    'content_hash', target.content_hash
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_ses_invoice_void_execution_v1(
  p_void_revision_id uuid,
  p_content_hash text,
  p_final_status text,
  p_provider_digest jsonb,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.makesafe_invoice_void_revisions%ROWTYPE;
BEGIN
  SELECT * INTO target
  FROM public.makesafe_invoice_void_revisions
  WHERE id = p_void_revision_id
  FOR UPDATE;
  IF NOT FOUND
     OR target.content_hash IS DISTINCT FROM p_content_hash
     OR target.target_status IS DISTINCT FROM p_final_status
     OR target.state NOT IN ('executing', 'confirmed') THEN
    RAISE EXCEPTION 'the SES void confirmation does not match the approved revision'
      USING ERRCODE = '23514';
  END IF;

  IF target.state = 'confirmed' THEN
    RETURN jsonb_build_object(
      'void_revision_id', target.id,
      'state', 'confirmed',
      'final_status', target.target_status
    );
  END IF;

  UPDATE public.xero_invoices
  SET status = p_final_status, synced_at = clock_timestamp()
  WHERE xero_invoice_id = target.xero_invoice_id
    AND job_id = target.job_id
    AND org_id = target.org_id;

  UPDATE public.makesafe_invoice_void_revisions
  SET
    state = 'confirmed',
    provider_digest = COALESCE(p_provider_digest, '{}'::jsonb),
    confirmed_at = COALESCE(confirmed_at, clock_timestamp()),
    updated_at = clock_timestamp()
  WHERE id = target.id;

  IF target.invoice_obligation_revision_id IS NOT NULL THEN
    UPDATE public.makesafe_invoice_obligation_revisions
    SET state = 'void_linked', updated_at = clock_timestamp()
    WHERE id = target.invoice_obligation_revision_id;
    UPDATE public.makesafe_invoice_obligations
    SET status = 'void_linked'
    WHERE id = (
      SELECT obligation_id
      FROM public.makesafe_invoice_obligation_revisions
      WHERE id = target.invoice_obligation_revision_id
    );
  END IF;

  INSERT INTO public.job_events (job_id, event_type, detail_json)
  VALUES (
    target.job_id,
    'ses_invoice_void_confirmed',
    jsonb_build_object(
      'void_revision_id', target.id,
      'xero_invoice_id', target.xero_invoice_id,
      'final_status', p_final_status,
      'actor', p_actor
    )
  );
  RETURN jsonb_build_object(
    'void_revision_id', target.id,
    'state', 'confirmed',
    'final_status', p_final_status
  );
END;
$$;

ALTER TABLE public.makesafe_invoice_void_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.makesafe_invoice_void_approvals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.makesafe_invoice_void_revisions FROM anon, authenticated;
REVOKE ALL ON TABLE public.makesafe_invoice_void_approvals FROM anon, authenticated;
GRANT ALL ON TABLE public.makesafe_invoice_void_revisions TO service_role;
GRANT ALL ON TABLE public.makesafe_invoice_void_approvals TO service_role;

REVOKE ALL ON FUNCTION public.seal_makesafe_job_v1(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_ses_invoice_void_revision_v1(
  uuid, uuid, uuid, text, uuid, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_ses_invoice_void_execution_v1(uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_ses_invoice_void_revision_v1(
  uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_ses_invoice_void_execution_v1(
  uuid, text, text, jsonb, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seal_makesafe_job_v1(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ses_invoice_void_revision_v1(
  uuid, uuid, uuid, text, uuid, text, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_ses_invoice_void_execution_v1(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_ses_invoice_void_revision_v1(
  uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_ses_invoice_void_execution_v1(
  uuid, text, text, jsonb, text
) TO service_role;

COMMENT ON COLUMN public.jobs.ses_money_sealed_at IS
  'Write-once authoritative SES money/outbound seal; never infer unsealed from mutable display fields.';
COMMENT ON TABLE public.makesafe_invoice_void_revisions IS
  'Content-addressed prepare/approve/execute authority for voiding a sealed SES ACCREC invoice.';
