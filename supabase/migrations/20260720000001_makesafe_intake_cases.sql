-- Deterministic make-safe intake, U1 canonical case model.
--
-- This migration is an inert structural seam. It creates no cron, adapter,
-- job, card, message, AI call, backfill or runtime wiring. Applying it is
-- separately Captain-gated.
--
-- One case is stored per source instruction, not per canonical WO/PO identity.
-- Adapters must derive source_instruction_key from the stable source message id
-- plus a stable deliverable discriminator when one message contains more than
-- one instruction. Replay uses the same key. Re-sends, twin Graph posts and
-- genuinely separate deliverables use different keys and remain separate cases.
-- Canonical builder/ref/PO columns are deliberately NOT unique.

CREATE OR REPLACE FUNCTION public.makesafe_intake_field_names_valid(p_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT
    NOT EXISTS (
      SELECT 1
      FROM unnest(p_values) AS item(value)
      WHERE value IS NULL
        OR value !~ '^[a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?$'
    )
    AND cardinality(p_values) = (
      SELECT count(DISTINCT value)
      FROM unnest(p_values) AS item(value)
    );
$$;

CREATE OR REPLACE FUNCTION public.makesafe_intake_identity_provenance_valid(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_value) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_value) AS field(name, provenance)
      WHERE jsonb_typeof(provenance) <> 'object'
        OR provenance ->> 'method' IS NULL
        OR provenance ->> 'method' NOT IN ('deterministic', 'ai', 'human')
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.makesafe_intake_case_transition_allowed(
  p_from_state text,
  p_to_state text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_from_state
    WHEN 'confirmed_live_job' THEN
      p_to_state IN ('blocked_live_job')
    WHEN 'blocked_live_job' THEN
      p_to_state IN ('confirmed_live_job', 'exception')
    WHEN 'exception' THEN
      p_to_state IN (
        'confirmed_live_job',
        'blocked_live_job',
        'accounted_non_wo'
      )
    WHEN 'accounted_non_wo' THEN
      p_to_state IN ('exception')
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.makesafe_intake_field_names_valid(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.makesafe_intake_identity_provenance_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.makesafe_intake_case_transition_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_field_names_valid(text[]) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_identity_provenance_valid(jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_case_transition_allowed(text, text) TO service_role, postgres;

CREATE TABLE public.makesafe_intake_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.organisations(id) ON DELETE RESTRICT,

  -- Stable source identity and replay seam. The instruction key is opaque to
  -- Postgres and must include a deliverable discriminator where required.
  source_system text NOT NULL,
  source_mailbox text NOT NULL,
  source_instruction_key text NOT NULL,
  source_message_id text NOT NULL,
  source_internet_message_id text,
  source_conversation_id text,
  source_thread_id text,
  source_received_at timestamptz NOT NULL,
  source_payload_sha256 text,
  instruction_fingerprint text,

  -- Source values are immutable once present. Canonical values may be refined,
  -- but only alongside updated per-field provenance.
  raw_builder_name text,
  canonical_builder_slug text,
  raw_external_ref text,
  canonical_external_ref text,
  raw_po_number text,
  canonical_po_number text,
  raw_deliverable_ref text,
  canonical_deliverable_ref text,
  raw_identity_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  identity_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,

  client_name text,
  site_address text,
  missing_fields text[] NOT NULL DEFAULT '{}',
  conflicting_fields jsonb NOT NULL DEFAULT '{}'::jsonb,

  current_state text NOT NULL,
  blocking_reasons text[] NOT NULL DEFAULT '{}',
  exception_reason_code text,
  accounted_non_wo_reason text,

  -- result_job_id is the job produced for confirmed/blocked cases.
  -- related_job_id may point from an exception to the existing job it concerns.
  result_job_id uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,
  related_job_id uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,
  source_intake_draft_id uuid
    REFERENCES public.makesafe_intake_drafts(id) ON DELETE RESTRICT,

  state_version integer NOT NULL DEFAULT 1,
  last_decision_provenance text NOT NULL DEFAULT 'deterministic',
  last_decision_actor text NOT NULL DEFAULT 'deterministic_adapter',
  last_decision_reason text NOT NULL DEFAULT 'initial_classification',
  last_decision_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_cases_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT makesafe_intake_cases_source_instruction_key
    UNIQUE (org_id, source_system, source_mailbox, source_instruction_key),
  CONSTRAINT makesafe_intake_cases_source_values_present CHECK (
    btrim(source_system) <> ''
    AND btrim(source_mailbox) <> ''
    AND btrim(source_instruction_key) <> ''
    AND btrim(source_message_id) <> ''
  ),
  CONSTRAINT makesafe_intake_cases_hashes_check CHECK (
    (source_payload_sha256 IS NULL OR source_payload_sha256 ~ '^[0-9a-fA-F]{64}$')
    AND (instruction_fingerprint IS NULL OR instruction_fingerprint ~ '^[0-9a-fA-F]{64}$')
  ),
  CONSTRAINT makesafe_intake_cases_json_shapes_check CHECK (
    jsonb_typeof(raw_identity_json) = 'object'
    AND public.makesafe_intake_identity_provenance_valid(identity_provenance)
    AND jsonb_typeof(conflicting_fields) = 'object'
    AND (
      (
        canonical_builder_slug IS NULL
        AND canonical_external_ref IS NULL
        AND canonical_po_number IS NULL
        AND canonical_deliverable_ref IS NULL
      )
      OR identity_provenance <> '{}'::jsonb
    )
  ),
  CONSTRAINT makesafe_intake_cases_field_names_check CHECK (
    public.makesafe_intake_field_names_valid(missing_fields)
    AND public.makesafe_intake_field_names_valid(blocking_reasons)
  ),
  CONSTRAINT makesafe_intake_cases_state_version_check CHECK (state_version > 0),
  CONSTRAINT makesafe_intake_cases_provenance_check CHECK (
    last_decision_provenance IN ('deterministic', 'ai', 'human')
  ),
  CONSTRAINT makesafe_intake_cases_reason_code_check CHECK (
    exception_reason_code IS NULL OR exception_reason_code IN (
      'cancellation',
      'duplicate',
      'revision',
      'unknown_builder',
      'non_makesafe',
      'ambiguous_scope',
      'below_identity_floor',
      'adapter_parse_failure',
      'conflicting_fields'
    )
  ),
  CONSTRAINT makesafe_intake_cases_state_shape_check CHECK (
    (
      current_state = 'confirmed_live_job'
      AND result_job_id IS NOT NULL
      AND cardinality(blocking_reasons) = 0
      AND exception_reason_code IS NULL
      AND accounted_non_wo_reason IS NULL
    )
    OR (
      current_state = 'blocked_live_job'
      AND result_job_id IS NOT NULL
      AND cardinality(blocking_reasons) > 0
      AND exception_reason_code IS NULL
      AND accounted_non_wo_reason IS NULL
    )
    OR (
      current_state = 'exception'
      AND result_job_id IS NULL
      AND cardinality(blocking_reasons) = 0
      AND exception_reason_code IS NOT NULL
      AND accounted_non_wo_reason IS NULL
    )
    OR (
      current_state = 'accounted_non_wo'
      AND result_job_id IS NULL
      AND related_job_id IS NULL
      AND cardinality(blocking_reasons) = 0
      AND exception_reason_code IS NULL
      AND accounted_non_wo_reason IS NOT NULL
      AND btrim(accounted_non_wo_reason) <> ''
    )
  )
);

-- Deliberately non-unique candidate-match indexes. Same refs and POs may be a
-- replay, revision, re-send, sibling or genuinely separate deliverable. Lineage
-- decides that later; these indexes never collapse cases.
CREATE INDEX idx_makesafe_intake_cases_queue
  ON public.makesafe_intake_cases (org_id, current_state, source_received_at DESC);
CREATE INDEX idx_makesafe_intake_cases_source_message
  ON public.makesafe_intake_cases (org_id, source_system, source_message_id);
CREATE INDEX idx_makesafe_intake_cases_internet_message
  ON public.makesafe_intake_cases (org_id, source_internet_message_id)
  WHERE source_internet_message_id IS NOT NULL;
CREATE INDEX idx_makesafe_intake_cases_canonical_identity
  ON public.makesafe_intake_cases (
    org_id,
    canonical_builder_slug,
    canonical_external_ref,
    canonical_po_number,
    canonical_deliverable_ref
  );
CREATE INDEX idx_makesafe_intake_cases_fingerprint
  ON public.makesafe_intake_cases (org_id, instruction_fingerprint)
  WHERE instruction_fingerprint IS NOT NULL;
CREATE INDEX idx_makesafe_intake_cases_result_job
  ON public.makesafe_intake_cases (org_id, result_job_id)
  WHERE result_job_id IS NOT NULL;
CREATE INDEX idx_makesafe_intake_cases_related_job
  ON public.makesafe_intake_cases (org_id, related_job_id)
  WHERE related_job_id IS NOT NULL;

CREATE TABLE public.makesafe_intake_case_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  case_id uuid NOT NULL,
  state_version integer NOT NULL,
  from_state text,
  to_state text NOT NULL CHECK (to_state IN (
    'confirmed_live_job',
    'blocked_live_job',
    'exception',
    'accounted_non_wo'
  )),
  decision_provenance text NOT NULL CHECK (
    decision_provenance IN ('deterministic', 'ai', 'human')
  ),
  decision_actor text NOT NULL,
  decision_reason text NOT NULL,
  missing_fields_snapshot text[] NOT NULL DEFAULT '{}',
  conflicting_fields_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocking_reasons_snapshot text[] NOT NULL DEFAULT '{}',
  exception_reason_code_snapshot text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_case_transitions_case_fk
    FOREIGN KEY (org_id, case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_transitions_case_version_key
    UNIQUE (org_id, case_id, state_version),
  CONSTRAINT makesafe_intake_case_transitions_initial_or_valid_check CHECK (
    (state_version = 1 AND from_state IS NULL)
    OR (
      state_version > 1
      AND from_state IS NOT NULL
      AND public.makesafe_intake_case_transition_allowed(from_state, to_state)
    )
  ),
  CONSTRAINT makesafe_intake_case_transitions_json_shapes_check CHECK (
    jsonb_typeof(conflicting_fields_snapshot) = 'object'
    AND jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX idx_makesafe_intake_case_transitions_history
  ON public.makesafe_intake_case_transitions
  (org_id, case_id, state_version DESC);
CREATE INDEX idx_makesafe_intake_case_transitions_decided
  ON public.makesafe_intake_case_transitions (org_id, decided_at DESC);

CREATE TABLE public.makesafe_intake_case_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  case_id uuid NOT NULL,
  evidence_role text NOT NULL DEFAULT 'primary'
    CHECK (evidence_role IN ('primary', 'supporting', 'replay_observation')),
  source_system text NOT NULL,
  source_mailbox text NOT NULL,
  source_message_id text NOT NULL,
  source_internet_message_id text,
  source_conversation_id text,
  source_thread_id text,
  source_email_post_id text REFERENCES public.emails(post_id) ON DELETE RESTRICT,
  received_at timestamptz NOT NULL,
  content_sha256 text,
  provenance text NOT NULL CHECK (provenance IN ('deterministic', 'ai', 'human')),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_case_sources_case_fk
    FOREIGN KEY (org_id, case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_sources_message_key
    UNIQUE (org_id, case_id, source_system, source_mailbox, source_message_id),
  CONSTRAINT makesafe_intake_case_sources_values_present CHECK (
    btrim(source_system) <> ''
    AND btrim(source_mailbox) <> ''
    AND btrim(source_message_id) <> ''
  ),
  CONSTRAINT makesafe_intake_case_sources_hash_check CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT makesafe_intake_case_sources_json_shape_check CHECK (
    jsonb_typeof(evidence_json) = 'object'
  )
);

CREATE INDEX idx_makesafe_intake_case_sources_internet_message
  ON public.makesafe_intake_case_sources (org_id, source_internet_message_id)
  WHERE source_internet_message_id IS NOT NULL;
CREATE INDEX idx_makesafe_intake_case_sources_conversation
  ON public.makesafe_intake_case_sources (org_id, source_conversation_id)
  WHERE source_conversation_id IS NOT NULL;

CREATE TABLE public.makesafe_intake_case_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  case_id uuid NOT NULL,
  source_attachment_id uuid
    REFERENCES public.email_attachments(id) ON DELETE RESTRICT,
  source_attachment_key text NOT NULL,
  source_message_id text NOT NULL,
  raw_name text,
  raw_content_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 text,
  storage_path_snapshot text,
  status_snapshot text,
  provenance text NOT NULL CHECK (provenance IN ('deterministic', 'ai', 'human')),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_case_attachments_case_fk
    FOREIGN KEY (org_id, case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_attachments_source_key
    UNIQUE (org_id, case_id, source_attachment_key),
  CONSTRAINT makesafe_intake_case_attachments_values_present CHECK (
    btrim(source_attachment_key) <> '' AND btrim(source_message_id) <> ''
  ),
  CONSTRAINT makesafe_intake_case_attachments_hash_check CHECK (
    sha256 IS NULL OR sha256 ~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT makesafe_intake_case_attachments_json_shape_check CHECK (
    jsonb_typeof(evidence_json) = 'object'
  )
);

CREATE INDEX idx_makesafe_intake_case_attachments_case
  ON public.makesafe_intake_case_attachments (org_id, case_id);
CREATE INDEX idx_makesafe_intake_case_attachments_sha
  ON public.makesafe_intake_case_attachments (org_id, sha256)
  WHERE sha256 IS NOT NULL;

CREATE TABLE public.makesafe_intake_case_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  from_case_id uuid NOT NULL,
  relation_type text NOT NULL CHECK (relation_type IN (
    'revision_of',
    'duplicate_of',
    'cancellation_of',
    'sibling_of',
    'reopen_of'
  )),
  to_case_id uuid NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('deterministic', 'ai', 'human')),
  decided_by text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_case_lineage_from_fk
    FOREIGN KEY (org_id, from_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_lineage_to_fk
    FOREIGN KEY (org_id, to_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_lineage_no_self_check
    CHECK (from_case_id <> to_case_id),
  -- Store sibling pairs once in UUID order so A-B and B-A cannot coexist.
  CONSTRAINT makesafe_intake_case_lineage_sibling_order_check
    CHECK (relation_type <> 'sibling_of' OR from_case_id < to_case_id),
  CONSTRAINT makesafe_intake_case_lineage_edge_key
    UNIQUE (org_id, from_case_id, relation_type, to_case_id),
  CONSTRAINT makesafe_intake_case_lineage_evidence_shape_check
    CHECK (jsonb_typeof(evidence) = 'object')
);

-- One duplicate case can have exactly one canonical duplicate parent.
CREATE UNIQUE INDEX uq_makesafe_intake_case_lineage_duplicate_parent
  ON public.makesafe_intake_case_lineage (org_id, from_case_id)
  WHERE relation_type = 'duplicate_of';
CREATE INDEX idx_makesafe_intake_case_lineage_from
  ON public.makesafe_intake_case_lineage (org_id, from_case_id, relation_type);
CREATE INDEX idx_makesafe_intake_case_lineage_to
  ON public.makesafe_intake_case_lineage (org_id, to_case_id, relation_type);

CREATE OR REPLACE FUNCTION public.enforce_makesafe_intake_case_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  canonical_changed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.state_version := 1;
    NEW.last_decision_at := COALESCE(NEW.last_decision_at, now());
  ELSE
    IF NEW.org_id IS DISTINCT FROM OLD.org_id
      OR NEW.source_system IS DISTINCT FROM OLD.source_system
      OR NEW.source_mailbox IS DISTINCT FROM OLD.source_mailbox
      OR NEW.source_instruction_key IS DISTINCT FROM OLD.source_instruction_key
      OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id
      OR NEW.source_internet_message_id IS DISTINCT FROM OLD.source_internet_message_id
      OR NEW.source_conversation_id IS DISTINCT FROM OLD.source_conversation_id
      OR NEW.source_thread_id IS DISTINCT FROM OLD.source_thread_id
      OR NEW.source_received_at IS DISTINCT FROM OLD.source_received_at
      OR NEW.source_payload_sha256 IS DISTINCT FROM OLD.source_payload_sha256
      OR NEW.instruction_fingerprint IS DISTINCT FROM OLD.instruction_fingerprint
    THEN
      RAISE EXCEPTION 'make-safe case source identity is immutable';
    END IF;

    IF (OLD.raw_builder_name IS NOT NULL AND NEW.raw_builder_name IS DISTINCT FROM OLD.raw_builder_name)
      OR (OLD.raw_external_ref IS NOT NULL AND NEW.raw_external_ref IS DISTINCT FROM OLD.raw_external_ref)
      OR (OLD.raw_po_number IS NOT NULL AND NEW.raw_po_number IS DISTINCT FROM OLD.raw_po_number)
      OR (OLD.raw_deliverable_ref IS NOT NULL AND NEW.raw_deliverable_ref IS DISTINCT FROM OLD.raw_deliverable_ref)
      OR (
        OLD.raw_identity_json <> '{}'::jsonb
        AND NEW.raw_identity_json IS DISTINCT FROM OLD.raw_identity_json
      )
    THEN
      RAISE EXCEPTION 'make-safe case raw identity values cannot be replaced or cleared';
    END IF;

    canonical_changed :=
      NEW.canonical_builder_slug IS DISTINCT FROM OLD.canonical_builder_slug
      OR NEW.canonical_external_ref IS DISTINCT FROM OLD.canonical_external_ref
      OR NEW.canonical_po_number IS DISTINCT FROM OLD.canonical_po_number
      OR NEW.canonical_deliverable_ref IS DISTINCT FROM OLD.canonical_deliverable_ref;
    IF NOT NEW.identity_provenance @> OLD.identity_provenance THEN
      RAISE EXCEPTION 'make-safe case identity provenance is append-only';
    END IF;
    IF canonical_changed
      AND NEW.identity_provenance IS NOT DISTINCT FROM OLD.identity_provenance
    THEN
      RAISE EXCEPTION 'canonical identity changes require updated identity_provenance';
    END IF;

    IF NEW.current_state IS DISTINCT FROM OLD.current_state THEN
      IF NEW.last_decision_reason IS NOT DISTINCT FROM OLD.last_decision_reason THEN
        RAISE EXCEPTION 'state transitions require a new decision reason';
      END IF;
      IF NOT public.makesafe_intake_case_transition_allowed(
        OLD.current_state,
        NEW.current_state
      ) THEN
        RAISE EXCEPTION 'invalid make-safe intake case transition: % -> %',
          OLD.current_state, NEW.current_state;
      END IF;
      NEW.state_version := OLD.state_version + 1;
      NEW.last_decision_at := now();
    ELSE
      IF NEW.state_version IS DISTINCT FROM OLD.state_version
        OR NEW.last_decision_provenance IS DISTINCT FROM OLD.last_decision_provenance
        OR NEW.last_decision_actor IS DISTINCT FROM OLD.last_decision_actor
        OR NEW.last_decision_reason IS DISTINCT FROM OLD.last_decision_reason
        OR NEW.last_decision_at IS DISTINCT FROM OLD.last_decision_at
      THEN
        RAISE EXCEPTION 'decision metadata may change only with a state transition';
      END IF;
    END IF;
    NEW.updated_at := now();
  END IF;

  IF btrim(NEW.last_decision_actor) = '' OR btrim(NEW.last_decision_reason) = '' THEN
    RAISE EXCEPTION 'state decisions require a named actor and reason';
  END IF;

  IF NEW.result_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = NEW.result_job_id
      AND j.org_id = NEW.org_id
      AND j.type = 'makesafe'
  ) THEN
    RAISE EXCEPTION 'result_job_id must reference a make-safe job in the same org';
  END IF;

  IF NEW.related_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = NEW.related_job_id
      AND j.org_id = NEW.org_id
      AND j.type = 'makesafe'
  ) THEN
    RAISE EXCEPTION 'related_job_id must reference a make-safe job in the same org';
  END IF;

  IF NEW.source_intake_draft_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.makesafe_intake_drafts d
    WHERE d.id = NEW.source_intake_draft_id
      AND d.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'source_intake_draft_id must reference the same org';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_makesafe_intake_case_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.current_state IS DISTINCT FROM OLD.current_state THEN
    INSERT INTO public.makesafe_intake_case_transitions (
      org_id,
      case_id,
      state_version,
      from_state,
      to_state,
      decision_provenance,
      decision_actor,
      decision_reason,
      missing_fields_snapshot,
      conflicting_fields_snapshot,
      blocking_reasons_snapshot,
      exception_reason_code_snapshot,
      decided_at
    ) VALUES (
      NEW.org_id,
      NEW.id,
      NEW.state_version,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.current_state END,
      NEW.current_state,
      NEW.last_decision_provenance,
      NEW.last_decision_actor,
      NEW.last_decision_reason,
      NEW.missing_fields,
      NEW.conflicting_fields,
      NEW.blocking_reasons,
      NEW.exception_reason_code,
      NEW.last_decision_at
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_makesafe_intake_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_makesafe_intake_case_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  creates_cycle boolean;
BEGIN
  -- Serialize graph changes within an org so two concurrent inserts cannot race
  -- the practical cycle check.
  PERFORM pg_advisory_xact_lock(
    hashtext('makesafe_intake_case_lineage:' || NEW.org_id::text)
  );

  IF NEW.relation_type <> 'sibling_of' THEN
    WITH RECURSIVE ancestors(case_id) AS (
      SELECT NEW.to_case_id
      UNION
      SELECT edge.to_case_id
      FROM public.makesafe_intake_case_lineage edge
      JOIN ancestors ON ancestors.case_id = edge.from_case_id
      WHERE edge.org_id = NEW.org_id
        AND edge.relation_type <> 'sibling_of'
    )
    SELECT EXISTS (
      SELECT 1 FROM ancestors WHERE case_id = NEW.from_case_id
    ) INTO creates_cycle;

    IF creates_cycle THEN
      RAISE EXCEPTION 'make-safe intake lineage edge would create a cycle';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_makesafe_intake_cases_enforce
  BEFORE INSERT OR UPDATE ON public.makesafe_intake_cases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_makesafe_intake_case_write();

CREATE TRIGGER trg_makesafe_intake_cases_record_transition
  AFTER INSERT OR UPDATE OF current_state ON public.makesafe_intake_cases
  FOR EACH ROW EXECUTE FUNCTION public.record_makesafe_intake_case_transition();

CREATE TRIGGER trg_makesafe_intake_case_transitions_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_intake_case_transitions
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

CREATE TRIGGER trg_makesafe_intake_case_sources_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_intake_case_sources
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

CREATE TRIGGER trg_makesafe_intake_case_attachments_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_intake_case_attachments
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

CREATE TRIGGER trg_makesafe_intake_case_lineage_enforce
  BEFORE INSERT ON public.makesafe_intake_case_lineage
  FOR EACH ROW EXECUTE FUNCTION public.enforce_makesafe_intake_case_lineage();

CREATE TRIGGER trg_makesafe_intake_case_lineage_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_intake_case_lineage
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

-- Backend-owned posture, matching the existing make-safe intake tables. No
-- authenticated/anon path is added by this inert slice. Composite foreign keys
-- and job/draft triggers enforce org boundaries even for service-role writes.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'makesafe_intake_cases',
    'makesafe_intake_case_transitions',
    'makesafe_intake_case_sources',
    'makesafe_intake_case_attachments',
    'makesafe_intake_case_lineage'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'service_role_all_' || table_name,
      table_name
    );
  END LOOP;
END $$;

COMMENT ON TABLE public.makesafe_intake_cases IS
  'Canonical deterministic make-safe intake case, one row per source instruction. Inert until later adapters and job creation are separately wired.';
COMMENT ON TABLE public.makesafe_intake_case_transitions IS
  'Append-only initial classification and valid state-transition audit, including deterministic/AI/human provenance and missing/conflict snapshots.';
COMMENT ON TABLE public.makesafe_intake_case_sources IS
  'Append-only source email/message evidence for a canonical case. Multiple messages may support one case and one message may support separate deliverable cases.';
COMMENT ON TABLE public.makesafe_intake_case_attachments IS
  'Append-only attachment evidence snapshots linked to existing private make-safe email attachments when available.';
COMMENT ON TABLE public.makesafe_intake_case_lineage IS
  'Append-only revision, duplicate, cancellation, sibling and reopen edges. Hierarchical cycles and ambiguous duplicate parentage are rejected.';

-- DOWN / ROLLBACK
-- The reviewed, non-auto-applied down script is:
--   supabase/rollbacks/20260720000001_makesafe_intake_cases_down.sql
-- It drops only this inert seam, in dependency order. It is destructive to any
-- case data written after a later adapter cutover, so it requires the same
-- Captain gate as apply and a data export once the seam is no longer empty.
