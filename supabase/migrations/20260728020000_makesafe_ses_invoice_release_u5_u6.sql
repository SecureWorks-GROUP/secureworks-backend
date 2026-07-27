-- SES Reporting U5/U6/U6R: invoice obligation identity, review authority,
-- and exact-once release effects.
--
-- This migration is deliberately additive. It does not create a Xero invoice,
-- authorise money, send mail, or complete a job. Those effects remain behind
-- explicit, revision-bound human approvals in ops-api.

CREATE INDEX IF NOT EXISTS idx_xero_invoices_ses_live_job
  ON public.xero_invoices (job_id, invoice_date DESC, id)
  WHERE invoice_type = 'ACCREC'
    AND COALESCE(status, '') NOT IN ('VOIDED', 'DELETED');

CREATE INDEX IF NOT EXISTS idx_xero_invoices_ses_live_reference
  ON public.xero_invoices (
    lower(regexp_replace(COALESCE(reference, ''), '[-[:space:]]+', '', 'g'))
  )
  WHERE invoice_type = 'ACCREC'
    AND COALESCE(status, '') NOT IN ('VOIDED', 'DELETED')
    AND length(btrim(COALESCE(reference, ''))) > 0;

ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS invoice_obligation_revision_id uuid,
  ADD COLUMN IF NOT EXISTS ses_external_token text,
  ADD COLUMN IF NOT EXISTS reference_normalized text GENERATED ALWAYS AS (
    lower(regexp_replace(COALESCE(reference, ''), '[-[:space:]]+', '', 'g'))
  ) STORED;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE UNIQUE INDEX IF NOT EXISTS uq_xero_invoices_ses_external_token
  ON public.xero_invoices (org_id, ses_external_token)
  WHERE ses_external_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_xero_invoices_ses_obligation_revision
  ON public.xero_invoices (invoice_obligation_revision_id)
  WHERE invoice_obligation_revision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_xero_invoices_ses_reference_normalized
  ON public.xero_invoices (reference_normalized)
  WHERE invoice_type = 'ACCREC'
    AND COALESCE(status, '') NOT IN ('VOIDED', 'DELETED')
    AND reference_normalized <> '';

CREATE INDEX IF NOT EXISTS idx_xero_invoices_ses_reference_trgm
  ON public.xero_invoices
  USING gin (reference_normalized public.gin_trgm_ops)
  WHERE invoice_type = 'ACCREC'
    AND COALESCE(status, '') NOT IN ('VOIDED', 'DELETED')
    AND reference_normalized <> '';

CREATE TABLE IF NOT EXISTS public.makesafe_invoice_obligations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'reserved', 'xero_bound', 'released', 'void_linked', 'closed')
  ),
  mint_reason text NOT NULL CHECK (length(btrim(mint_reason)) > 0),
  minted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  minted_by text NOT NULL CHECK (length(btrim(minted_by)) > 0),
  supersedes_obligation_id uuid
    REFERENCES public.makesafe_invoice_obligations(id) ON DELETE RESTRICT,
  post_release_disposition text CHECK (
    post_release_disposition IS NULL
    OR post_release_disposition IN (
      'second_invoice',
      'combine_credit',
      'document_only',
      'hold_pricing'
    )
  ),
  CONSTRAINT makesafe_invoice_obligation_no_self_supersession CHECK (
    supersedes_obligation_id IS NULL OR supersedes_obligation_id <> id
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_invoice_obligation_mutable_job
  ON public.makesafe_invoice_obligations (job_id)
  WHERE status IN ('open', 'reserved', 'xero_bound');

CREATE INDEX IF NOT EXISTS idx_makesafe_invoice_obligations_job
  ON public.makesafe_invoice_obligations (job_id, minted_at DESC, id);

CREATE TABLE IF NOT EXISTS public.makesafe_invoice_obligation_revisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  obligation_id uuid NOT NULL
    REFERENCES public.makesafe_invoice_obligations(id) ON DELETE RESTRICT,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  attendance_cycle_ids uuid[] NOT NULL CHECK (cardinality(attendance_cycle_ids) > 0),
  attendance_cycle_set_hash text NOT NULL
    CHECK (attendance_cycle_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  pricing_disposition text NOT NULL CHECK (
    pricing_disposition IN (
      'priced_from_canon',
      'priced_with_line_override',
      'no_additional_charge',
      'money_review_required',
      'blocked_missing_evidence',
      'blocked_company_ambiguous',
      'blocked_parked_rule',
      'blocked_billing_disposition',
      'blocked_duplicate_live'
    )
  ),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object'),
  duplicate_probe jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(duplicate_probe) = 'object'),
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(blockers) = 'array'),
  xero_binding jsonb CHECK (
    xero_binding IS NULL OR jsonb_typeof(xero_binding) = 'object'
  ),
  supersedes_revision_id uuid
    REFERENCES public.makesafe_invoice_obligation_revisions(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (
    state IN (
      'proposed',
      'pending_approval',
      'create_approved',
      'create_executed',
      'authorised',
      'released',
      'superseded',
      'void_linked',
      'blocked'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT makesafe_invoice_revision_no_self_supersession CHECK (
    supersedes_revision_id IS NULL OR supersedes_revision_id <> id
  ),
  UNIQUE (obligation_id, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_invoice_revision_active
  ON public.makesafe_invoice_obligation_revisions (obligation_id)
  WHERE state NOT IN ('superseded', 'void_linked');

CREATE INDEX IF NOT EXISTS idx_makesafe_invoice_revisions_job
  ON public.makesafe_invoice_obligation_revisions (job_id, created_at DESC, id);

ALTER TABLE public.xero_invoices
  DROP CONSTRAINT IF EXISTS xero_invoices_invoice_obligation_revision_id_fkey;
ALTER TABLE public.xero_invoices
  ADD CONSTRAINT xero_invoices_invoice_obligation_revision_id_fkey
  FOREIGN KEY (invoice_obligation_revision_id)
  REFERENCES public.makesafe_invoice_obligation_revisions(id)
  ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS public.makesafe_invoice_obligation_cycles (
  obligation_revision_id uuid NOT NULL
    REFERENCES public.makesafe_invoice_obligation_revisions(id) ON DELETE RESTRICT,
  obligation_id uuid NOT NULL
    REFERENCES public.makesafe_invoice_obligations(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  attendance_cycle_id uuid NOT NULL
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  commercially_closed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (obligation_revision_id, attendance_cycle_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_invoice_cycle_active
  ON public.makesafe_invoice_obligation_cycles (attendance_cycle_id)
  WHERE active;

CREATE TABLE IF NOT EXISTS public.makesafe_release_revisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  content_hash text NOT NULL UNIQUE CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'proposed' CHECK (
    state IN ('proposed', 'approved', 'dispatching', 'released', 'blocked', 'superseded')
  ),
  dependency_generation bigint NOT NULL CHECK (dependency_generation >= 0),
  readiness_bindings jsonb NOT NULL CHECK (
    jsonb_typeof(readiness_bindings) = 'array'
    AND jsonb_array_length(readiness_bindings) > 0
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.makesafe_release_revision_members (
  release_revision_id uuid NOT NULL
    REFERENCES public.makesafe_release_revisions(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  docket_revision_id uuid NOT NULL
    REFERENCES public.makesafe_docket_revisions(id) ON DELETE RESTRICT,
  invoice_obligation_revision_id uuid
    REFERENCES public.makesafe_invoice_obligation_revisions(id) ON DELETE RESTRICT,
  attendance_cycle_ids uuid[] NOT NULL CHECK (cardinality(attendance_cycle_ids) > 0),
  PRIMARY KEY (release_revision_id, ordinal),
  UNIQUE (release_revision_id, docket_revision_id),
  UNIQUE (release_revision_id, job_id)
);

CREATE TABLE IF NOT EXISTS public.makesafe_release_revision_routes (
  release_revision_id uuid NOT NULL
    REFERENCES public.makesafe_release_revisions(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  route_kind text NOT NULL CHECK (route_kind IN ('report', 'photo', 'invoice')),
  recipients text[] NOT NULL CHECK (cardinality(recipients) > 0),
  cc text[] NOT NULL DEFAULT '{}'::text[],
  subject text NOT NULL CHECK (length(btrim(subject)) > 0),
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  body_hash text NOT NULL CHECK (body_hash ~ '^sha256:[0-9a-f]{64}$'),
  attachment_hashes text[] NOT NULL DEFAULT '{}'::text[],
  envelope_hash text NOT NULL CHECK (envelope_hash ~ '^sha256:[0-9a-f]{64}$'),
  required boolean NOT NULL DEFAULT true,
  PRIMARY KEY (release_revision_id, route_kind),
  UNIQUE (release_revision_id, ordinal)
);

CREATE TABLE IF NOT EXISTS public.ses_external_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE CHECK (length(btrim(operation_key)) > 0),
  org_id uuid NOT NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,
  effect_kind text NOT NULL CHECK (
    effect_kind IN (
      'invoice_create',
      'invoice_authorise',
      'route_send',
      'document_store'
    )
  ),
  invoice_obligation_revision_id uuid
    REFERENCES public.makesafe_invoice_obligation_revisions(id) ON DELETE RESTRICT,
  release_revision_id uuid
    REFERENCES public.makesafe_release_revisions(id) ON DELETE RESTRICT,
  docket_revision_id uuid
    REFERENCES public.makesafe_docket_revisions(id) ON DELETE RESTRICT,
  route_kind text CHECK (
    route_kind IS NULL OR route_kind IN ('report', 'photo', 'invoice')
  ),
  artifact_hash text CHECK (
    artifact_hash IS NULL OR artifact_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  external_token text NOT NULL UNIQUE CHECK (length(btrim(external_token)) > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (
    state IN ('reserved', 'dispatching', 'unknown', 'confirmed', 'failed', 'compensated')
  ),
  lease_owner text,
  lease_expires_at timestamptz,
  external_id text,
  provider_digest jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(provider_digest) = 'object'),
  failure jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(failure) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  CONSTRAINT ses_external_effect_shape CHECK (
    (effect_kind = 'invoice_create'
      AND invoice_obligation_revision_id IS NOT NULL
      AND release_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'invoice_authorise'
      AND invoice_obligation_revision_id IS NOT NULL
      AND release_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'route_send'
      AND release_revision_id IS NOT NULL
      AND route_kind IS NOT NULL)
    OR (effect_kind = 'document_store'
      AND docket_revision_id IS NOT NULL
      AND artifact_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_invoice_create
  ON public.ses_external_effects (invoice_obligation_revision_id)
  WHERE effect_kind = 'invoice_create';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_invoice_authorise
  ON public.ses_external_effects (invoice_obligation_revision_id)
  WHERE effect_kind = 'invoice_authorise';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_route_send
  ON public.ses_external_effects (release_revision_id, route_kind)
  WHERE effect_kind = 'route_send';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_document_store
  ON public.ses_external_effects (docket_revision_id, artifact_hash)
  WHERE effect_kind = 'document_store';

CREATE INDEX IF NOT EXISTS idx_ses_external_effects_nonterminal
  ON public.ses_external_effects (state, updated_at)
  WHERE state IN ('reserved', 'dispatching', 'unknown', 'failed');

CREATE TABLE IF NOT EXISTS public.ses_external_effect_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  effect_id uuid NOT NULL REFERENCES public.ses_external_effects(id) ON DELETE RESTRICT,
  from_state text,
  to_state text NOT NULL,
  event_kind text NOT NULL CHECK (length(btrim(event_kind)) > 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_ses_external_effect_events_effect
  ON public.ses_external_effect_events (effect_id, id);

CREATE TABLE IF NOT EXISTS public.ses_release_route_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_revision_id uuid NOT NULL
    REFERENCES public.makesafe_release_revisions(id) ON DELETE RESTRICT,
  invoice_obligation_revision_id uuid
    REFERENCES public.makesafe_invoice_obligation_revisions(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  attendance_cycle_ids uuid[] NOT NULL CHECK (cardinality(attendance_cycle_ids) > 0),
  route_kind text NOT NULL CHECK (route_kind IN ('report', 'photo', 'invoice')),
  external_message_token text NOT NULL,
  external_message_id text NOT NULL,
  effect_id uuid NOT NULL
    REFERENCES public.ses_external_effects(id) ON DELETE RESTRICT,
  member_bindings jsonb NOT NULL CHECK (
    jsonb_typeof(member_bindings) = 'array'
    AND jsonb_array_length(member_bindings) > 0
  ),
  proof_hash text NOT NULL CHECK (proof_hash ~ '^sha256:[0-9a-f]{64}$'),
  proven_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (release_revision_id, route_kind),
  UNIQUE (effect_id)
);

CREATE TABLE IF NOT EXISTS public.makesafe_closeout_revisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  release_revision_id uuid NOT NULL UNIQUE
    REFERENCES public.makesafe_release_revisions(id) ON DELETE RESTRICT,
  content_hash text NOT NULL UNIQUE CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  required_proof_hashes text[] NOT NULL CHECK (
    cardinality(required_proof_hashes) > 0
  ),
  verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0)
);

CREATE TABLE IF NOT EXISTS public.ses_review_feedback_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  docket_revision_id uuid NOT NULL
    REFERENCES public.makesafe_docket_revisions(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  change_type text NOT NULL CHECK (length(btrim(change_type)) > 0),
  before_value jsonb NOT NULL DEFAULT 'null'::jsonb,
  after_value jsonb NOT NULL DEFAULT 'null'::jsonb,
  operator_id uuid,
  operator text NOT NULL CHECK (length(btrim(operator)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.ses_release_operators (
  user_id uuid PRIMARY KEY,
  operator_class text NOT NULL CHECK (
    operator_class IN ('shaun_clean', 'captain', 'admin_owner')
  ),
  active boolean NOT NULL DEFAULT true,
  configured_by text NOT NULL CHECK (length(btrim(configured_by)) > 0),
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.makesafe_revision_approvals
  ADD COLUMN IF NOT EXISTS invoice_obligation_revision_id uuid
    REFERENCES public.makesafe_invoice_obligation_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approval_content_hash text,
  ADD COLUMN IF NOT EXISTS includes_authorise boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS clean_at_decision boolean,
  ADD COLUMN IF NOT EXISTS captain_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS operator_id uuid;

ALTER TABLE public.makesafe_revision_approvals
  DROP CONSTRAINT IF EXISTS makesafe_revision_approvals_content_hash_check;
ALTER TABLE public.makesafe_revision_approvals
  ADD CONSTRAINT makesafe_revision_approvals_content_hash_check CHECK (
    approval_content_hash IS NULL
    OR approval_content_hash ~ '^sha256:[0-9a-f]{64}$'
  );

ALTER TABLE public.makesafe_docket_revisions
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'pre_xero',
  ADD COLUMN IF NOT EXISTS invoice_obligation_revision_id uuid
    REFERENCES public.makesafe_invoice_obligation_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS xero_binding jsonb,
  ADD COLUMN IF NOT EXISTS based_on_revision_id uuid
    REFERENCES public.makesafe_docket_revisions(id) ON DELETE RESTRICT;

ALTER TABLE public.makesafe_docket_revisions
  DROP CONSTRAINT IF EXISTS makesafe_docket_revisions_ses_stage_check;
ALTER TABLE public.makesafe_docket_revisions
  ADD CONSTRAINT makesafe_docket_revisions_ses_stage_check CHECK (
    (stage = 'pre_xero' AND xero_binding IS NULL)
    OR (
      stage = 'invoice_bound'
      AND invoice_obligation_revision_id IS NOT NULL
      AND xero_binding IS NOT NULL
      AND xero_binding->>'status' = 'AUTHORISED'
      AND based_on_revision_id IS NOT NULL
    )
  );

CREATE OR REPLACE VIEW public.makesafe_docket_revisions_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (revision.job_id)
  revision.*
FROM public.makesafe_docket_revisions revision
ORDER BY revision.job_id, revision.committed_at DESC, revision.id DESC;

CREATE OR REPLACE VIEW public.makesafe_readiness_current_v2
WITH (security_invoker = true)
AS
SELECT
  current_row.job_id,
  current_row.org_id,
  current_row.dependency_generation,
  current_row.readiness_revision,
  current_row.attendance_cycle_set_hash,
  current_row.family_matrix_revision,
  COALESCE((
    current_row.ready
    AND revision.ready
    AND revision.attendance_cycle_set_hash =
      current_row.attendance_cycle_set_hash
    AND revision.family_matrix_revision =
      current_row.family_matrix_revision
  ), false) AS ready,
  current_row.invalidated_at,
  current_row.invalidation_reason,
  current_row.updated_at,
  revision.dependency_envelope,
  COALESCE(revision.blockers, '[]'::jsonb) AS blockers
FROM public.makesafe_readiness_current current_row
LEFT JOIN public.makesafe_readiness_revisions revision
  ON revision.job_id = current_row.job_id
 AND revision.readiness_revision = current_row.readiness_revision;

CREATE OR REPLACE VIEW public.makesafe_revision_approvals_current_v2
WITH (security_invoker = true)
AS
SELECT approval.*
FROM public.makesafe_revision_approvals approval
JOIN public.makesafe_readiness_current_v2 readiness
  ON readiness.job_id = approval.job_id
 AND readiness.readiness_revision = approval.readiness_revision
 AND readiness.dependency_generation = approval.dependency_generation
WHERE approval.decision = 'approved'
  AND readiness.ready = true;

CREATE OR REPLACE FUNCTION public.reject_makesafe_invoice_revision_content_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.attendance_cycle_ids IS DISTINCT FROM OLD.attendance_cycle_ids
     OR NEW.attendance_cycle_set_hash IS DISTINCT FROM OLD.attendance_cycle_set_hash
     OR NEW.pricing_disposition IS DISTINCT FROM OLD.pricing_disposition
     OR NEW.proposal IS DISTINCT FROM OLD.proposal
     OR NEW.duplicate_probe IS DISTINCT FROM OLD.duplicate_probe
     OR NEW.blockers IS DISTINCT FROM OLD.blockers
     OR NEW.supersedes_revision_id IS DISTINCT FROM OLD.supersedes_revision_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'invoice obligation revision content is immutable; append a new revision'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_makesafe_invoice_revision_content_immutable
  ON public.makesafe_invoice_obligation_revisions;
CREATE TRIGGER trg_makesafe_invoice_revision_content_immutable
  BEFORE UPDATE ON public.makesafe_invoice_obligation_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_invoice_revision_content_change();

CREATE OR REPLACE FUNCTION public.reject_ses_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER trg_ses_external_effect_events_append_only
  BEFORE UPDATE OR DELETE ON public.ses_external_effect_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_ses_append_only_change();
CREATE TRIGGER trg_ses_release_route_proofs_append_only
  BEFORE UPDATE OR DELETE ON public.ses_release_route_proofs
  FOR EACH ROW EXECUTE FUNCTION public.reject_ses_append_only_change();
CREATE TRIGGER trg_ses_review_feedback_events_append_only
  BEFORE UPDATE OR DELETE ON public.ses_review_feedback_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_ses_append_only_change();
CREATE TRIGGER trg_makesafe_closeout_revisions_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_closeout_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_ses_append_only_change();
CREATE TRIGGER trg_makesafe_release_members_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_release_revision_members
  FOR EACH ROW EXECUTE FUNCTION public.reject_ses_append_only_change();
CREATE TRIGGER trg_makesafe_release_routes_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_release_revision_routes
  FOR EACH ROW EXECUTE FUNCTION public.reject_ses_append_only_change();

CREATE OR REPLACE FUNCTION public.reject_makesafe_release_revision_content_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.dependency_generation IS DISTINCT FROM OLD.dependency_generation
     OR NEW.readiness_bindings IS DISTINCT FROM OLD.readiness_bindings
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'release revision content is immutable; append a new revision'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_makesafe_release_revision_content_immutable
  BEFORE UPDATE ON public.makesafe_release_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_release_revision_content_change();

CREATE OR REPLACE FUNCTION public.commit_ses_invoice_obligation_revision_v1(
  p_obligation jsonb,
  p_revision jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  target_job_id uuid := (p_obligation->>'job_id')::uuid;
  target_obligation_id uuid := (p_obligation->>'id')::uuid;
  target_revision_id uuid := (p_revision->>'id')::uuid;
  target_cycles uuid[];
  existing_revision public.makesafe_invoice_obligation_revisions%ROWTYPE;
  active_revision public.makesafe_invoice_obligation_revisions%ROWTYPE;
  prior_readiness record;
  next_generation bigint;
  next_envelope jsonb;
  next_readiness_revision text;
  next_ready boolean;
  next_blockers jsonb;
BEGIN
  IF jsonb_typeof(p_obligation) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_revision) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'obligation and revision objects are required'
      USING ERRCODE = '22023';
  END IF;

  target_cycles := ARRAY(
    SELECT DISTINCT value::uuid
    FROM jsonb_array_elements_text(p_revision->'attendance_cycle_ids')
    ORDER BY value::uuid
  );
  IF cardinality(target_cycles) = 0 THEN
    RAISE EXCEPTION 'at least one attendance cycle is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ses-invoice-job:' || target_job_id::text, 0));
  PERFORM 1 FROM public.jobs WHERE id = target_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT
    current_row.dependency_generation,
    current_row.readiness_revision,
    current_row.ready AS current_ready,
    revision.attendance_cycle_set_hash,
    revision.family_matrix_revision,
    revision.dependency_envelope,
    revision.blockers
  INTO prior_readiness
  FROM public.makesafe_readiness_current current_row
  JOIN public.makesafe_readiness_revisions revision
    ON revision.job_id = current_row.job_id
   AND revision.readiness_revision = current_row.readiness_revision
  WHERE current_row.job_id = target_job_id
  FOR UPDATE OF current_row;
  IF NOT FOUND OR NOT prior_readiness.current_ready THEN
    RAISE EXCEPTION 'the job has no current ready evidence revision to bind to this invoice proposal'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO existing_revision
  FROM public.makesafe_invoice_obligation_revisions
  WHERE id = target_revision_id;
  IF FOUND THEN
    IF existing_revision.content_hash = p_revision->>'content_hash'
       AND existing_revision.obligation_id = target_obligation_id THEN
      RETURN jsonb_build_object(
        'obligation_id', target_obligation_id,
        'invoice_obligation_revision_id', target_revision_id,
        'content_hash', existing_revision.content_hash,
        'idempotent', true
      );
    END IF;
    RAISE EXCEPTION 'invoice obligation revision id resolves to different content'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.makesafe_invoice_obligations (
    id, org_id, job_id, status, mint_reason, minted_by,
    supersedes_obligation_id, post_release_disposition
  ) VALUES (
    target_obligation_id,
    (p_obligation->>'org_id')::uuid,
    target_job_id,
    COALESCE(NULLIF(p_obligation->>'status', ''), 'open'),
    p_obligation->>'mint_reason',
    p_obligation->>'minted_by',
    NULLIF(p_obligation->>'supersedes_obligation_id', '')::uuid,
    NULLIF(p_obligation->>'post_release_disposition', '')
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT * INTO active_revision
  FROM public.makesafe_invoice_obligation_revisions
  WHERE obligation_id = target_obligation_id
    AND state NOT IN ('superseded', 'void_linked')
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF active_revision.state IN ('create_executed', 'authorised', 'released') THEN
      RAISE EXCEPTION
        'released or Xero-bound work cannot be superseded; create a new obligation after human disposition'
        USING ERRCODE = '23514';
    END IF;
    IF NULLIF(p_revision->>'supersedes_revision_id', '')::uuid
       IS DISTINCT FROM active_revision.id THEN
      RAISE EXCEPTION 'new revision must explicitly supersede the current pending revision'
        USING ERRCODE = '23514';
    END IF;
    UPDATE public.makesafe_invoice_obligation_revisions
    SET state = 'superseded'
    WHERE id = active_revision.id;
    UPDATE public.makesafe_invoice_obligation_cycles
    SET active = false
    WHERE obligation_revision_id = active_revision.id;
  END IF;

  INSERT INTO public.makesafe_invoice_obligation_revisions (
    id,
    org_id,
    job_id,
    obligation_id,
    content_hash,
    attendance_cycle_ids,
    attendance_cycle_set_hash,
    pricing_disposition,
    proposal,
    duplicate_probe,
    blockers,
    supersedes_revision_id,
    state,
    created_by
  ) VALUES (
    target_revision_id,
    (p_revision->>'org_id')::uuid,
    target_job_id,
    target_obligation_id,
    p_revision->>'content_hash',
    target_cycles,
    p_revision->>'attendance_cycle_set_hash',
    p_revision->>'pricing_disposition',
    p_revision->'proposal',
    COALESCE(p_revision->'duplicate_probe', '{}'::jsonb),
    COALESCE(p_revision->'blockers', '[]'::jsonb),
    NULLIF(p_revision->>'supersedes_revision_id', '')::uuid,
    p_revision->>'state',
    p_revision->>'created_by'
  );

  INSERT INTO public.makesafe_invoice_obligation_cycles (
    obligation_revision_id,
    obligation_id,
    job_id,
    attendance_cycle_id
  )
  SELECT target_revision_id, target_obligation_id, target_job_id, cycle_id
  FROM unnest(target_cycles) AS cycle_id;

  next_generation := public.invalidate_makesafe_readiness(
    target_job_id,
    'makesafe_invoice_obligation_revisions',
    target_revision_id::text,
    'The invoice obligation revision changed the reviewed commercial facts.',
    p_revision->>'created_by'
  );
  next_envelope := jsonb_set(
    jsonb_set(
      prior_readiness.dependency_envelope,
      '{invoice_obligation}',
      jsonb_build_object(
        'id', target_obligation_id,
        'revision', target_revision_id
      ),
      true
    ),
    '{docket,revision_id}',
    to_jsonb(p_revision->>'docket_revision_id'),
    true
  );
  next_readiness_revision :=
    public.makesafe_readiness_revision_v1(next_envelope);
  next_ready := prior_readiness.current_ready AND
    p_revision->>'state' <> 'blocked';
  next_blockers := CASE
    WHEN next_ready THEN COALESCE(prior_readiness.blockers, '[]'::jsonb)
    ELSE COALESCE(prior_readiness.blockers, '[]'::jsonb) ||
      COALESCE(p_revision->'blockers', '[]'::jsonb)
  END;
  PERFORM public.commit_makesafe_readiness(
    target_job_id,
    next_generation,
    next_readiness_revision,
    prior_readiness.attendance_cycle_set_hash,
    prior_readiness.family_matrix_revision,
    next_envelope,
    next_ready,
    next_blockers,
    p_revision->>'created_by'
  );

  RETURN jsonb_build_object(
    'obligation_id', target_obligation_id,
    'invoice_obligation_revision_id', target_revision_id,
    'content_hash', p_revision->>'content_hash',
    'readiness_revision', next_readiness_revision,
    'dependency_generation', next_generation,
    'idempotent', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_ses_external_effect_v1(
  p_effect jsonb,
  p_lease_owner text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  target public.ses_external_effects%ROWTYPE;
  target_key text := btrim(p_effect->>'operation_key');
BEGIN
  IF jsonb_typeof(p_effect) IS DISTINCT FROM 'object'
     OR target_key = ''
     OR p_lease_seconds < 10
     OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'valid effect, operation_key, and 10..900 second lease are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ses-effect:' || target_key, 0));

  SELECT * INTO target
  FROM public.ses_external_effects
  WHERE operation_key = target_key
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.ses_external_effects (
      operation_key,
      org_id,
      job_id,
      effect_kind,
      invoice_obligation_revision_id,
      release_revision_id,
      docket_revision_id,
      route_kind,
      artifact_hash,
      payload_hash,
      external_token,
      state,
      lease_owner,
      lease_expires_at
    ) VALUES (
      target_key,
      (p_effect->>'org_id')::uuid,
      NULLIF(p_effect->>'job_id', '')::uuid,
      p_effect->>'effect_kind',
      NULLIF(p_effect->>'invoice_obligation_revision_id', '')::uuid,
      NULLIF(p_effect->>'release_revision_id', '')::uuid,
      NULLIF(p_effect->>'docket_revision_id', '')::uuid,
      NULLIF(p_effect->>'route_kind', ''),
      NULLIF(p_effect->>'artifact_hash', ''),
      p_effect->>'payload_hash',
      p_effect->>'external_token',
      'reserved',
      p_lease_owner,
      clock_timestamp() + make_interval(secs => p_lease_seconds)
    )
    RETURNING * INTO target;

    INSERT INTO public.ses_external_effect_events (
      effect_id, from_state, to_state, event_kind, detail, actor
    ) VALUES (
      target.id, NULL, 'reserved', 'reserved',
      jsonb_build_object('operation_key', target.operation_key),
      p_lease_owner
    );

    RETURN jsonb_build_object(
      'effect', to_jsonb(target),
      'claim_mode', 'dispatch',
      'duplicate_refused', false
    );
  END IF;

  IF target.payload_hash IS DISTINCT FROM p_effect->>'payload_hash'
     OR target.effect_kind IS DISTINCT FROM p_effect->>'effect_kind'
     OR target.external_token IS DISTINCT FROM p_effect->>'external_token' THEN
    RAISE EXCEPTION 'operation_key already belongs to different immutable effect content'
      USING ERRCODE = '23505';
  END IF;

  RETURN jsonb_build_object(
    'effect', to_jsonb(target),
    'claim_mode', CASE
      WHEN target.state = 'confirmed' THEN 'confirmed'
      ELSE 'reconcile'
    END,
    'duplicate_refused', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_ses_external_effect_v1(
  p_operation_key text,
  p_from_state text,
  p_to_state text,
  p_event_kind text,
  p_detail jsonb,
  p_actor text
)
RETURNS public.ses_external_effects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.ses_external_effects%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-effect:' || btrim(p_operation_key), 0)
  );
  SELECT * INTO target
  FROM public.ses_external_effects
  WHERE operation_key = btrim(p_operation_key)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'external effect does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF target.state IS DISTINCT FROM p_from_state THEN
    RAISE EXCEPTION 'external effect state changed; reconcile the existing operation'
      USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (p_from_state = 'reserved' AND p_to_state IN ('dispatching', 'failed'))
    OR (p_from_state = 'dispatching' AND p_to_state IN ('unknown', 'confirmed', 'failed'))
    OR (p_from_state = 'unknown' AND p_to_state IN ('confirmed', 'failed'))
    OR (p_from_state = 'failed' AND p_to_state IN ('unknown', 'confirmed', 'compensated'))
    OR (p_from_state = 'confirmed' AND p_to_state = 'compensated')
  ) THEN
    RAISE EXCEPTION 'invalid external effect transition % -> %', p_from_state, p_to_state
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.ses_external_effects
  SET
    state = p_to_state,
    external_id = COALESCE(NULLIF(p_detail->>'external_id', ''), external_id),
    provider_digest = CASE
      WHEN p_detail ? 'provider_digest' THEN p_detail->'provider_digest'
      ELSE provider_digest
    END,
    failure = CASE
      WHEN p_detail ? 'failure' THEN p_detail->'failure'
      ELSE failure
    END,
    updated_at = clock_timestamp(),
    confirmed_at = CASE
      WHEN p_to_state = 'confirmed' THEN clock_timestamp()
      ELSE confirmed_at
    END
  WHERE id = target.id
  RETURNING * INTO target;

  INSERT INTO public.ses_external_effect_events (
    effect_id, from_state, to_state, event_kind, detail, actor
  ) VALUES (
    target.id, p_from_state, p_to_state, p_event_kind,
    COALESCE(p_detail, '{}'::jsonb), p_actor
  );
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_ses_revision_approval_v1(
  p_approval jsonb
)
RETURNS public.makesafe_revision_approvals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_readiness record;
  operator_row public.ses_release_operators%ROWTYPE;
  inserted public.makesafe_revision_approvals%ROWTYPE;
  target_action text := p_approval->>'action';
  target_operator uuid := (p_approval->>'operator_id')::uuid;
  target_admin_owner boolean := COALESCE((p_approval->>'is_admin_owner')::boolean, false);
  target_clean boolean := COALESCE((p_approval->>'clean')::boolean, false);
  target_captain_override boolean :=
    COALESCE((p_approval->>'captain_override')::boolean, false);
BEGIN
  IF target_action NOT IN ('invoice', 'release') THEN
    RAISE EXCEPTION 'SES approval action must be invoice or release'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO operator_row
  FROM public.ses_release_operators
  WHERE user_id = target_operator AND active = true;
  IF NOT FOUND AND NOT target_admin_owner THEN
    RAISE EXCEPTION 'operator is not on the SES release allowlist'
      USING ERRCODE = '42501';
  END IF;
  IF NOT target_clean
     AND NOT target_admin_owner
     AND COALESCE(operator_row.operator_class, '') NOT IN ('captain', 'admin_owner') THEN
    RAISE EXCEPTION 'this docket is not mechanically clean; Captain approval is required'
      USING ERRCODE = '42501';
  END IF;
  IF target_captain_override
     AND NOT target_admin_owner
     AND COALESCE(operator_row.operator_class, '') NOT IN ('captain', 'admin_owner') THEN
    RAISE EXCEPTION 'Captain override requires Captain or admin-owner authority'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    current_row.*,
    revision.ready AS revision_ready
  INTO current_readiness
  FROM public.makesafe_readiness_current current_row
  JOIN public.makesafe_readiness_revisions revision
    ON revision.job_id = current_row.job_id
   AND revision.readiness_revision = current_row.readiness_revision
  WHERE current_row.job_id = (p_approval->>'job_id')::uuid
  FOR UPDATE OF current_row;
  IF NOT FOUND
     OR NOT current_readiness.ready
     OR NOT current_readiness.revision_ready
     OR current_readiness.readiness_revision IS DISTINCT FROM p_approval->>'readiness_revision'
     OR current_readiness.dependency_generation IS DISTINCT FROM
       (p_approval->>'dependency_generation')::bigint THEN
    RAISE EXCEPTION 'new evidence landed; review the current docket revision again'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.makesafe_revision_approvals (
    org_id,
    job_id,
    action,
    decision,
    readiness_revision,
    dependency_generation,
    docket_revision_id,
    release_revision_id,
    invoice_obligation_revision_id,
    approval_content_hash,
    includes_authorise,
    clean_at_decision,
    captain_override,
    operator_id,
    decided_by,
    evidence_refs
  ) VALUES (
    (p_approval->>'org_id')::uuid,
    (p_approval->>'job_id')::uuid,
    target_action,
    'approved',
    p_approval->>'readiness_revision',
    (p_approval->>'dependency_generation')::bigint,
    NULLIF(p_approval->>'docket_revision_id', '')::uuid,
    NULLIF(p_approval->>'release_revision_id', '')::uuid,
    NULLIF(p_approval->>'invoice_obligation_revision_id', '')::uuid,
    p_approval->>'approval_content_hash',
    COALESCE((p_approval->>'includes_authorise')::boolean, false),
    target_clean,
    target_captain_override,
    target_operator,
    p_approval->>'decided_by',
    COALESCE(p_approval->'evidence_refs', '[]'::jsonb)
  )
  RETURNING * INTO inserted;

  INSERT INTO public.ses_review_feedback_events (
    docket_revision_id,
    job_id,
    change_type,
    before_value,
    after_value,
    operator_id,
    operator
  ) VALUES (
    (p_approval->>'docket_revision_id')::uuid,
    (p_approval->>'job_id')::uuid,
    target_action || '_approval',
    'null'::jsonb,
    jsonb_build_object(
      'approval_id', inserted.id,
      'approval_content_hash', p_approval->>'approval_content_hash',
      'readiness_revision', p_approval->>'readiness_revision',
      'dependency_generation', (p_approval->>'dependency_generation')::bigint
    ),
    target_operator,
    p_approval->>'decided_by'
  );
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_ses_invoice_execution_v1(
  p_job_id uuid,
  p_invoice_obligation_revision_id uuid,
  p_approval_content_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_revision public.makesafe_invoice_obligation_revisions%ROWTYPE;
  current_readiness public.makesafe_readiness_current%ROWTYPE;
  current_approval public.makesafe_revision_approvals%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'ses-invoice-execute:' || p_invoice_obligation_revision_id::text,
      0
    )
  );

  SELECT * INTO target_revision
  FROM public.makesafe_invoice_obligation_revisions
  WHERE id = p_invoice_obligation_revision_id
    AND job_id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the approved invoice obligation revision no longer exists'
      USING ERRCODE = 'P0002';
  END IF;
  IF target_revision.state NOT IN (
    'proposed',
    'pending_approval',
    'create_approved',
    'create_executed'
  ) THEN
    RAISE EXCEPTION 'the invoice obligation is not in an executable pre-release state'
      USING ERRCODE = '23514';
  END IF;
  IF target_revision.pricing_disposition NOT IN (
    'priced_from_canon',
    'priced_with_line_override'
  ) OR jsonb_array_length(target_revision.blockers) > 0 THEN
    RAISE EXCEPTION 'the invoice obligation has no executable priced line set'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO current_readiness
  FROM public.makesafe_readiness_current
  WHERE job_id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the current readiness row no longer exists'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO current_approval
  FROM public.makesafe_revision_approvals_current_v2
  WHERE action = 'invoice'
    AND job_id = p_job_id
    AND invoice_obligation_revision_id = p_invoice_obligation_revision_id
    AND approval_content_hash = p_approval_content_hash
  ORDER BY decided_at DESC
  LIMIT 1;
  IF NOT FOUND
     OR current_approval.readiness_revision IS DISTINCT FROM
       current_readiness.readiness_revision
     OR current_approval.dependency_generation IS DISTINCT FROM
       current_readiness.dependency_generation THEN
    RAISE EXCEPTION 'new evidence landed; review the current invoice revision again'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.makesafe_invoice_obligation_revisions
  SET state = 'create_approved'
  WHERE id = p_invoice_obligation_revision_id
    AND state IN ('proposed', 'pending_approval');

  RETURN jsonb_build_object(
    'invoice_obligation_revision_id',
    p_invoice_obligation_revision_id,
    'readiness_revision',
    current_readiness.readiness_revision,
    'dependency_generation',
    current_readiness.dependency_generation,
    'state',
    CASE
      WHEN target_revision.state IN ('proposed', 'pending_approval')
        THEN 'create_approved'
      ELSE target_revision.state
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_ses_release_execution_v1(
  p_release_revision_id uuid,
  p_release_content_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_release public.makesafe_release_revisions%ROWTYPE;
  binding jsonb;
  current_readiness public.makesafe_readiness_current%ROWTYPE;
  approved_count integer := 0;
  member_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'ses-release-execute:' || p_release_revision_id::text,
      0
    )
  );

  SELECT * INTO target_release
  FROM public.makesafe_release_revisions
  WHERE id = p_release_revision_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the approved release revision no longer exists'
      USING ERRCODE = 'P0002';
  END IF;
  IF target_release.content_hash IS DISTINCT FROM p_release_content_hash THEN
    RAISE EXCEPTION 'the displayed release content no longer matches the stored revision'
      USING ERRCODE = '23514';
  END IF;
  IF target_release.state NOT IN ('approved', 'dispatching', 'released') THEN
    RAISE EXCEPTION 'human SEND IT approval is missing for this release revision'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO member_count
  FROM public.makesafe_release_revision_members
  WHERE release_revision_id = p_release_revision_id;
  IF member_count <> jsonb_array_length(target_release.readiness_bindings) THEN
    RAISE EXCEPTION 'the release member set does not match its readiness bindings'
      USING ERRCODE = '23514';
  END IF;

  FOR binding IN
    SELECT value
    FROM jsonb_array_elements(target_release.readiness_bindings)
  LOOP
    SELECT * INTO current_readiness
    FROM public.makesafe_readiness_current
    WHERE job_id = (binding->>'job_id')::uuid
    FOR UPDATE;
    IF NOT FOUND
       OR NOT current_readiness.ready
       OR current_readiness.readiness_revision IS DISTINCT FROM
         binding->>'readiness_revision'
       OR current_readiness.dependency_generation IS DISTINCT FROM
         (binding->>'dependency_generation')::bigint THEN
      RAISE EXCEPTION 'new evidence landed; review the current release revision again'
        USING ERRCODE = '40001';
    END IF;

    PERFORM 1
    FROM public.makesafe_revision_approvals_current_v2
    WHERE action = 'release'
      AND release_revision_id = p_release_revision_id
      AND job_id = (binding->>'job_id')::uuid
      AND approval_content_hash = p_release_content_hash;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'human SEND IT approval is missing for a release member'
        USING ERRCODE = '42501';
    END IF;
    approved_count := approved_count + 1;
  END LOOP;

  IF approved_count <> member_count THEN
    RAISE EXCEPTION 'human SEND IT approval does not cover the exact release member set'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.makesafe_release_revisions
  SET state = 'dispatching'
  WHERE id = p_release_revision_id
    AND state = 'approved';

  RETURN jsonb_build_object(
    'release_revision_id',
    p_release_revision_id,
    'content_hash',
    target_release.content_hash,
    'member_count',
    member_count,
    'state',
    CASE
      WHEN target_release.state = 'approved' THEN 'dispatching'
      ELSE target_release.state
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_ses_review_feedback_v1(
  p_feedback jsonb
)
RETURNS public.ses_review_feedback_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted public.ses_review_feedback_events%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_feedback) IS DISTINCT FROM 'object'
     OR NULLIF(btrim(p_feedback->>'change_type'), '') IS NULL
     OR NULLIF(p_feedback->>'operator_id', '') IS NULL THEN
    RAISE EXCEPTION 'identified operator and concrete review change are required'
      USING ERRCODE = '22023';
  END IF;
  PERFORM 1
  FROM public.makesafe_docket_revisions
  WHERE id = (p_feedback->>'docket_revision_id')::uuid
    AND job_id = (p_feedback->>'job_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the reviewed docket revision no longer exists for this job'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.ses_review_feedback_events (
    docket_revision_id,
    job_id,
    change_type,
    before_value,
    after_value,
    operator_id,
    operator
  ) VALUES (
    (p_feedback->>'docket_revision_id')::uuid,
    (p_feedback->>'job_id')::uuid,
    p_feedback->>'change_type',
    COALESCE(p_feedback->'before', 'null'::jsonb),
    COALESCE(p_feedback->'after', 'null'::jsonb),
    (p_feedback->>'operator_id')::uuid,
    p_feedback->>'operator'
  ) RETURNING * INTO inserted;

  PERFORM public.invalidate_makesafe_readiness(
    inserted.job_id,
    'ses_review_feedback_events',
    inserted.id::text,
    'Human review feedback changed the facts or presentation that must be reviewed.',
    inserted.operator
  );
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_ses_invoice_bound_docket_v1(
  p_binding jsonb,
  p_pdf_artifact jsonb
)
RETURNS public.makesafe_docket_revisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  base public.makesafe_docket_revisions%ROWTYPE;
  inserted public.makesafe_docket_revisions%ROWTYPE;
  target_id uuid := (p_binding->>'id')::uuid;
  target_job_id uuid := (p_binding->>'job_id')::uuid;
  target_revision_id uuid :=
    (p_binding->>'invoice_obligation_revision_id')::uuid;
  target_xero jsonb := p_binding->'xero_binding';
  target_pdf_hash text := p_pdf_artifact->>'content_hash';
  prior_effect public.ses_external_effects%ROWTYPE;
  prior_readiness record;
  next_generation bigint;
  next_envelope jsonb;
  next_readiness_revision text;
BEGIN
  IF jsonb_typeof(p_binding) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_pdf_artifact) IS DISTINCT FROM 'object'
     OR target_xero->>'status' IS DISTINCT FROM 'AUTHORISED'
     OR target_pdf_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_pdf_artifact->>'role' IS DISTINCT FROM 'xero_invoice_pdf' THEN
    RAISE EXCEPTION 'AUTHORISED Xero binding and real invoice PDF artifact are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-invoice-docket:' || target_revision_id::text, 0)
  );
  SELECT * INTO inserted
  FROM public.makesafe_docket_revisions
  WHERE id = target_id;
  IF FOUND THEN
    IF inserted.stage = 'invoice_bound'
       AND inserted.invoice_obligation_revision_id = target_revision_id
       AND inserted.xero_binding->>'xero_invoice_id' =
         target_xero->>'xero_invoice_id' THEN
      RETURN inserted;
    END IF;
    RAISE EXCEPTION 'invoice-bound docket id resolves to different content'
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO base
  FROM public.makesafe_docket_revisions
  WHERE id = (p_binding->>'based_on_revision_id')::uuid
    AND job_id = target_job_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the reviewed pre-Xero docket revision no longer exists'
      USING ERRCODE = 'P0002';
  END IF;
  IF base.stage <> 'pre_xero' THEN
    RAISE EXCEPTION 'invoice PDF must bind from a pre-Xero docket revision'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO prior_effect
  FROM public.ses_external_effects
  WHERE invoice_obligation_revision_id = target_revision_id
    AND effect_kind = 'invoice_authorise'
    AND state = 'confirmed'
    AND external_id = target_xero->>'xero_invoice_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the AUTHORISED Xero invoice is not confirmed by the exact effect ledger'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.makesafe_revision_approvals approvals
    WHERE approvals.job_id = target_job_id
      AND approvals.action = 'release'
      AND approvals.decided_at >= base.committed_at
  ) THEN
    RAISE EXCEPTION 'attach the Xero PDF before recording SEND IT approval'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    current_row.ready AS current_ready,
    revision.attendance_cycle_set_hash,
    revision.family_matrix_revision,
    revision.dependency_envelope,
    revision.blockers
  INTO prior_readiness
  FROM public.makesafe_readiness_current current_row
  JOIN public.makesafe_readiness_revisions revision
    ON revision.job_id = current_row.job_id
   AND revision.readiness_revision = current_row.readiness_revision
  WHERE current_row.job_id = target_job_id
  FOR UPDATE OF current_row;
  IF NOT FOUND OR NOT prior_readiness.current_ready THEN
    RAISE EXCEPTION 'new evidence landed; review the current docket revision again'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.makesafe_docket_revisions (
    id,
    org_id,
    job_id,
    source_instruction_id,
    lineage_id,
    attendance_cycle_ids,
    current_attendance_cycle_id,
    readiness_revision,
    idempotency_key,
    assembler_version,
    family_matrix_version,
    input_content_hash,
    output_content_hash,
    state,
    pre_xero_docs_ready,
    local_invoice_proposal,
    envelope,
    blockers,
    email_drafts,
    review_spec,
    release_payload,
    superseded_revision_id,
    retention_class,
    artifact_count,
    artifact_size_bytes,
    accepted_at,
    committed_at,
    duration_ms,
    within_five_minutes,
    sla_breach,
    stage_durations_ms,
    created_by,
    stage,
    invoice_obligation_revision_id,
    xero_binding,
    based_on_revision_id
  ) VALUES (
    target_id,
    base.org_id,
    base.job_id,
    base.source_instruction_id,
    base.lineage_id,
    base.attendance_cycle_ids,
    base.current_attendance_cycle_id,
    base.readiness_revision,
    'ses-invoice-bound:' || target_revision_id::text,
    base.assembler_version,
    base.family_matrix_version,
    base.input_content_hash,
    p_binding->>'output_content_hash',
    'ready',
    true,
    base.local_invoice_proposal,
    jsonb_set(
      jsonb_set(base.envelope, '{invoice_create_approved}', 'false'::jsonb, true),
      '{client_send_approved}',
      'false'::jsonb,
      true
    ),
    '[]'::jsonb,
    base.email_drafts,
    base.review_spec || jsonb_build_object(
      'xero_binding', target_xero,
      'invoice_pdf_content_hash', target_pdf_hash
    ),
    jsonb_set(
      jsonb_set(base.release_payload, '{invoice_create_approved}', 'false'::jsonb, true),
      '{client_send_approved}',
      'false'::jsonb,
      true
    ),
    base.id,
    'operations-record',
    base.artifact_count + 1,
    base.artifact_size_bytes + (p_pdf_artifact->>'size_bytes')::bigint,
    base.accepted_at,
    clock_timestamp(),
    base.duration_ms,
    base.within_five_minutes,
    base.sla_breach,
    base.stage_durations_ms,
    COALESCE(NULLIF(p_binding->>'created_by', ''), 'ses-u6-invoice-bind'),
    'invoice_bound',
    target_revision_id,
    target_xero,
    base.id
  ) RETURNING * INTO inserted;

  INSERT INTO public.makesafe_docket_artifacts (
    org_id,
    revision_id,
    job_id,
    role,
    object_key,
    media_type,
    content_hash,
    size_bytes,
    metadata,
    created_by
  )
  SELECT
    artifact.org_id,
    inserted.id,
    artifact.job_id,
    artifact.role,
    artifact.object_key,
    artifact.media_type,
    artifact.content_hash,
    artifact.size_bytes,
    artifact.metadata,
    inserted.created_by
  FROM public.makesafe_docket_artifacts artifact
  WHERE artifact.revision_id = base.id;

  INSERT INTO public.makesafe_docket_artifacts (
    org_id,
    revision_id,
    job_id,
    role,
    object_key,
    media_type,
    content_hash,
    size_bytes,
    metadata,
    created_by
  ) VALUES (
    inserted.org_id,
    inserted.id,
    inserted.job_id,
    'xero_invoice_pdf',
    p_pdf_artifact->>'object_key',
    'application/pdf',
    target_pdf_hash,
    (p_pdf_artifact->>'size_bytes')::bigint,
    COALESCE(p_pdf_artifact->'metadata', '{}'::jsonb),
    inserted.created_by
  );

  UPDATE public.makesafe_invoice_obligation_revisions
  SET state = 'authorised', xero_binding = target_xero
  WHERE id = target_revision_id
    AND state IN ('create_executed', 'create_approved');
  UPDATE public.makesafe_invoice_obligations obligation
  SET status = 'xero_bound'
  WHERE obligation.id = (
    SELECT revision.obligation_id
    FROM public.makesafe_invoice_obligation_revisions revision
    WHERE revision.id = target_revision_id
  );

  next_generation := public.invalidate_makesafe_readiness(
    target_job_id,
    'makesafe_docket_revisions',
    inserted.id::text,
    'The real AUTHORISED Xero PDF created a new exact docket revision.',
    inserted.created_by
  );
  next_envelope := jsonb_set(
    jsonb_set(
      prior_readiness.dependency_envelope,
      '{docket,revision_id}',
      to_jsonb(inserted.id::text),
      true
    ),
    '{docket,content_hash}',
    to_jsonb(inserted.output_content_hash),
    true
  );
  next_readiness_revision :=
    public.makesafe_readiness_revision_v1(next_envelope);
  PERFORM public.commit_makesafe_readiness(
    target_job_id,
    next_generation,
    next_readiness_revision,
    prior_readiness.attendance_cycle_set_hash,
    prior_readiness.family_matrix_revision,
    next_envelope,
    true,
    COALESCE(prior_readiness.blockers, '[]'::jsonb),
    inserted.created_by
  );
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_ses_release_route_v1(
  p_release_revision_id uuid,
  p_route_kind text,
  p_proof_hash text,
  p_actor text
)
RETURNS public.ses_release_route_proofs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_effect public.ses_external_effects%ROWTYPE;
  inserted public.ses_release_route_proofs%ROWTYPE;
  bindings jsonb;
  cycle_ids uuid[];
  first_job_id uuid;
  first_obligation_revision_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'ses-release-route:' || p_release_revision_id::text || ':' || p_route_kind,
      0
    )
  );
  SELECT * INTO inserted
  FROM public.ses_release_route_proofs
  WHERE release_revision_id = p_release_revision_id
    AND route_kind = p_route_kind;
  IF FOUND THEN
    IF inserted.proof_hash = p_proof_hash THEN
      RETURN inserted;
    END IF;
    RAISE EXCEPTION 'route proof already exists with different content'
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO target_effect
  FROM public.ses_external_effects
  WHERE release_revision_id = p_release_revision_id
    AND route_kind = p_route_kind
    AND effect_kind = 'route_send'
    AND state = 'confirmed'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the route send is not confirmed by the exact effect ledger'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    jsonb_agg(jsonb_build_object(
      'job_id', member.job_id,
      'docket_revision_id', member.docket_revision_id,
      'invoice_obligation_revision_id', member.invoice_obligation_revision_id,
      'attendance_cycle_ids', member.attendance_cycle_ids
    ) ORDER BY member.ordinal),
    ARRAY(
      SELECT DISTINCT cycle_id
      FROM public.makesafe_release_revision_members member_rows,
           unnest(member_rows.attendance_cycle_ids) AS cycle_id
      WHERE member_rows.release_revision_id = p_release_revision_id
      ORDER BY cycle_id
    ),
    (array_agg(member.job_id ORDER BY member.ordinal))[1],
    (array_agg(member.invoice_obligation_revision_id ORDER BY member.ordinal))[1]
  INTO bindings, cycle_ids, first_job_id, first_obligation_revision_id
  FROM public.makesafe_release_revision_members member
  WHERE member.release_revision_id = p_release_revision_id;

  INSERT INTO public.ses_release_route_proofs (
    release_revision_id,
    invoice_obligation_revision_id,
    job_id,
    attendance_cycle_ids,
    route_kind,
    external_message_token,
    external_message_id,
    effect_id,
    member_bindings,
    proof_hash
  ) VALUES (
    p_release_revision_id,
    first_obligation_revision_id,
    first_job_id,
    cycle_ids,
    p_route_kind,
    target_effect.external_token,
    target_effect.external_id,
    target_effect.id,
    bindings,
    p_proof_hash
  ) RETURNING * INTO inserted;

  UPDATE public.makesafe_release_revisions
  SET state = 'dispatching', updated_at = clock_timestamp()
  WHERE id = p_release_revision_id AND state IN ('approved', 'dispatching');
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_ses_release_closeout_v1(
  p_closeout jsonb
)
RETURNS public.makesafe_closeout_revisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_release_id uuid := (p_closeout->>'release_revision_id')::uuid;
  target public.makesafe_closeout_revisions%ROWTYPE;
  required_count integer;
  proof_count integer;
  member record;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-release-closeout:' || target_release_id::text, 0)
  );
  SELECT * INTO target
  FROM public.makesafe_closeout_revisions
  WHERE release_revision_id = target_release_id;
  IF FOUND THEN
    IF target.content_hash = p_closeout->>'content_hash' THEN
      RETURN target;
    END IF;
    RAISE EXCEPTION 'release closeout already exists with different content'
      USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO required_count
  FROM public.makesafe_release_revision_routes
  WHERE release_revision_id = target_release_id AND required;
  SELECT count(*) INTO proof_count
  FROM public.ses_release_route_proofs
  WHERE release_revision_id = target_release_id;
  IF required_count = 0 OR proof_count <> required_count THEN
    RAISE EXCEPTION 'not every required release route has a confirmed proof'
      USING ERRCODE = '23514';
  END IF;

  IF ARRAY(
    SELECT proof_hash
    FROM public.ses_release_route_proofs
    WHERE release_revision_id = target_release_id
    ORDER BY route_kind
  ) IS DISTINCT FROM ARRAY(
    SELECT jsonb_array_elements_text(p_closeout->'required_proof_hashes')
    ORDER BY 1
  ) THEN
    RAISE EXCEPTION 'closeout proof hashes do not match the confirmed route ledger'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.makesafe_release_revision_members member_rows
    LEFT JOIN public.makesafe_invoice_obligation_revisions obligation_revision
      ON obligation_revision.id = member_rows.invoice_obligation_revision_id
    WHERE member_rows.release_revision_id = target_release_id
      AND (
        obligation_revision.id IS NULL
        OR NOT (
          obligation_revision.state = 'authorised'
          OR (
            obligation_revision.state = 'proposed'
            AND obligation_revision.pricing_disposition =
              'no_additional_charge'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'release member lacks either an AUTHORISED invoice or an explicit no-additional-charge obligation'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.makesafe_closeout_revisions (
    id,
    org_id,
    release_revision_id,
    content_hash,
    required_proof_hashes,
    verified,
    verified_at,
    created_by
  ) VALUES (
    (p_closeout->>'id')::uuid,
    (p_closeout->>'org_id')::uuid,
    target_release_id,
    p_closeout->>'content_hash',
    ARRAY(
      SELECT jsonb_array_elements_text(p_closeout->'required_proof_hashes')
      ORDER BY 1
    ),
    true,
    clock_timestamp(),
    p_closeout->>'created_by'
  ) RETURNING * INTO target;

  UPDATE public.makesafe_release_revisions
  SET state = 'released', updated_at = clock_timestamp()
  WHERE id = target_release_id;

  FOR member IN
    SELECT *
    FROM public.makesafe_release_revision_members
    WHERE release_revision_id = target_release_id
  LOOP
    IF member.invoice_obligation_revision_id IS NOT NULL THEN
      UPDATE public.makesafe_invoice_obligation_revisions
      SET state = 'released'
      WHERE id = member.invoice_obligation_revision_id
        AND (
          state = 'authorised'
          OR (
            state = 'proposed'
            AND pricing_disposition = 'no_additional_charge'
          )
        );
      UPDATE public.makesafe_invoice_obligation_cycles
      SET commercially_closed = true
      WHERE obligation_revision_id = member.invoice_obligation_revision_id;
      UPDATE public.makesafe_invoice_obligations obligation
      SET status = 'released'
      WHERE obligation.id = (
        SELECT revision.obligation_id
        FROM public.makesafe_invoice_obligation_revisions revision
        WHERE revision.id = member.invoice_obligation_revision_id
      );
    END IF;

    INSERT INTO public.makesafe_terminal_proofs (
      org_id,
      job_id,
      kind,
      attendance_cycle_ids,
      attendance_cycle_set_hash,
      readiness_revision,
      release_revision_id,
      closeout_revision_id,
      evidence_refs,
      proven_by
    )
    SELECT
      release.org_id,
      member.job_id,
      'release_closeout',
      member.attendance_cycle_ids,
      public.makesafe_attendance_cycle_set_hash_v1(member.attendance_cycle_ids),
      binding->>'readiness_revision',
      target_release_id,
      target.id,
      jsonb_build_array(
        jsonb_build_object(
          'kind', 'ses_release_closeout',
          'release_revision_id', target_release_id,
          'closeout_revision_id', target.id
        )
      ),
      p_closeout->>'created_by'
    FROM public.makesafe_release_revisions release,
         jsonb_array_elements(release.readiness_bindings) binding
    WHERE release.id = target_release_id
      AND binding->>'job_id' = member.job_id::text;

    INSERT INTO public.job_events (
      job_id,
      event_type,
      detail_json
    ) VALUES (
      member.job_id,
      'note',
      jsonb_build_object(
        'text',
        'MAKESAFE_PACK_SENT | main | SES release ' ||
          target_release_id::text || ' | closeout=' || target.id::text,
        'release_revision_id',
        target_release_id,
        'closeout_revision_id',
        target.id,
        'source',
        'ses-u6r'
      )
    );
  END LOOP;
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_ses_release_revision_v1(
  p_release jsonb,
  p_members jsonb,
  p_routes jsonb
)
RETURNS public.makesafe_release_revisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.makesafe_release_revisions%ROWTYPE;
  member jsonb;
  route jsonb;
BEGIN
  IF jsonb_typeof(p_release) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_members) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_members) = 0
     OR jsonb_typeof(p_routes) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_routes) <> 3
     OR p_routes->0->>'route_kind' IS DISTINCT FROM 'report'
     OR p_routes->1->>'route_kind' IS DISTINCT FROM 'photo'
     OR p_routes->2->>'route_kind' IS DISTINCT FROM 'invoice'
     OR (p_routes->0->>'ordinal')::integer IS DISTINCT FROM 0
     OR (p_routes->1->>'ordinal')::integer IS DISTINCT FROM 1
     OR (p_routes->2->>'ordinal')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'release members and the ordered report, photo, invoice routes are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-release:' || (p_release->>'id'), 0)
  );
  SELECT * INTO target
  FROM public.makesafe_release_revisions
  WHERE id = (p_release->>'id')::uuid;
  IF FOUND THEN
    IF target.content_hash = p_release->>'content_hash' THEN
      RETURN target;
    END IF;
    RAISE EXCEPTION 'release revision id resolves to different content'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.makesafe_release_revisions (
    id, org_id, content_hash, state, dependency_generation,
    readiness_bindings, created_by
  ) VALUES (
    (p_release->>'id')::uuid,
    (p_release->>'org_id')::uuid,
    p_release->>'content_hash',
    'proposed',
    (p_release->>'dependency_generation')::bigint,
    p_release->'readiness_bindings',
    p_release->>'created_by'
  ) RETURNING * INTO target;

  FOR member IN SELECT value FROM jsonb_array_elements(p_members) ORDER BY (value->>'ordinal')::integer
  LOOP
    INSERT INTO public.makesafe_release_revision_members (
      release_revision_id, ordinal, job_id, docket_revision_id,
      invoice_obligation_revision_id, attendance_cycle_ids
    ) VALUES (
      target.id,
      (member->>'ordinal')::integer,
      (member->>'job_id')::uuid,
      (member->>'docket_revision_id')::uuid,
      NULLIF(member->>'invoice_obligation_revision_id', '')::uuid,
      ARRAY(
        SELECT value::uuid
        FROM jsonb_array_elements_text(member->'attendance_cycle_ids')
        ORDER BY value::uuid
      )
    );
  END LOOP;

  FOR route IN SELECT value FROM jsonb_array_elements(p_routes) ORDER BY (value->>'ordinal')::integer
  LOOP
    INSERT INTO public.makesafe_release_revision_routes (
      release_revision_id, ordinal, route_kind, recipients, cc, subject,
      body, body_hash, attachment_hashes, envelope_hash, required
    ) VALUES (
      target.id,
      (route->>'ordinal')::integer,
      route->>'route_kind',
      ARRAY(SELECT jsonb_array_elements_text(route->'recipients')),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(route->'cc', '[]'::jsonb))),
      route->>'subject',
      route->>'body',
      route->>'body_hash',
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(route->'attachment_hashes', '[]'::jsonb))),
      route->>'envelope_hash',
      COALESCE((route->>'required')::boolean, true)
    );
  END LOOP;
  RETURN target;
END;
$$;

CREATE OR REPLACE VIEW public.makesafe_invoice_obligation_revisions_current
WITH (security_invoker = true)
AS
SELECT revision.*
FROM public.makesafe_invoice_obligation_revisions revision
WHERE revision.state NOT IN ('superseded', 'void_linked');

CREATE OR REPLACE VIEW public.ses_release_proof_ledger
WITH (security_invoker = true)
AS
SELECT
  release.id AS release_revision_id,
  release.content_hash AS release_content_hash,
  release.state AS release_state,
  route.route_kind,
  effect.operation_key,
  effect.state AS effect_state,
  effect.external_token,
  effect.external_id,
  proof.proof_hash,
  proof.proven_at,
  closeout.id AS closeout_revision_id,
  closeout.verified AS closeout_verified
FROM public.makesafe_release_revisions release
JOIN public.makesafe_release_revision_routes route
  ON route.release_revision_id = release.id
LEFT JOIN public.ses_external_effects effect
  ON effect.release_revision_id = release.id
 AND effect.route_kind = route.route_kind
 AND effect.effect_kind = 'route_send'
LEFT JOIN public.ses_release_route_proofs proof
  ON proof.release_revision_id = release.id
 AND proof.route_kind = route.route_kind
LEFT JOIN public.makesafe_closeout_revisions closeout
  ON closeout.release_revision_id = release.id;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'makesafe_invoice_obligations',
    'makesafe_invoice_obligation_revisions',
    'makesafe_invoice_obligation_cycles',
    'makesafe_release_revisions',
    'makesafe_release_revision_members',
    'makesafe_release_revision_routes',
    'ses_external_effects',
    'ses_external_effect_events',
    'ses_release_route_proofs',
    'makesafe_closeout_revisions',
    'ses_review_feedback_events',
    'ses_release_operators'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      table_name || '_service_role_only',
      table_name
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO service_role',
      table_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON public.makesafe_invoice_obligation_revisions_current
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ses_release_proof_ledger
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.makesafe_invoice_obligation_revisions_current TO service_role;
GRANT SELECT ON public.ses_release_proof_ledger TO service_role;

REVOKE ALL ON FUNCTION public.commit_ses_invoice_obligation_revision_v1(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ses_external_effect_v1(jsonb, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_ses_external_effect_v1(text, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_ses_revision_approval_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_ses_invoice_execution_v1(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_ses_release_execution_v1(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ses_release_revision_v1(jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ses_invoice_bound_docket_v1(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_ses_release_route_v1(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ses_release_closeout_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_ses_review_feedback_v1(jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commit_ses_invoice_obligation_revision_v1(jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ses_external_effect_v1(jsonb, text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_ses_external_effect_v1(text, text, text, text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_ses_revision_approval_v1(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_ses_invoice_execution_v1(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_ses_release_execution_v1(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ses_release_revision_v1(jsonb, jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ses_invoice_bound_docket_v1(jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_ses_release_route_v1(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ses_release_closeout_v1(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_ses_review_feedback_v1(jsonb)
  TO service_role;

REVOKE ALL ON SEQUENCE public.ses_external_effect_events_id_seq
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.ses_review_feedback_events_id_seq
  FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.ses_external_effect_events_id_seq
  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ses_review_feedback_events_id_seq
  TO service_role;

COMMENT ON TABLE public.makesafe_invoice_obligations IS
  'Stable commercial identities. Mutable cycle membership and pricing belong to immutable child revisions.';
COMMENT ON TABLE public.ses_external_effects IS
  'U6R exact-once reservations for Xero, Graph route sends, and content-addressed document stores.';
COMMENT ON TABLE public.ses_release_operators IS
  'Server-side allowlist for Shaun clean-band and Captain SES approval authority; user ids are operational configuration, never client constants.';
