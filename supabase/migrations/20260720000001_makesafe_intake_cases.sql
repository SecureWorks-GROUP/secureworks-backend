-- Deterministic make-safe intake, U1 canonical case spine.
--
-- INERTNESS
-- This migration creates only new tables, views, functions, triggers and indexes,
-- with one exception: makesafe_companies.org_id is backfilled and closed to NOT
-- NULL so the case org-scoping invariant is satisfiable. No row's org changes and
-- no behavior of that table changes. Beyond that it wires no scan, draft,
-- approval, job, board, notification, AI, backfill or production path. Applying
-- it remains Captain gated. No trigger in this migration is attached to an
-- existing table.
--
-- GRAIN AND AUTHORITY
-- A case is one source instruction. N source emails can attach to that case via
-- makesafe_intake_case_sources. The stable instruction_key includes deterministic
-- instruction content plus a deliverable discriminator. Twin posts, dual capture,
-- re-sends and late PDFs attach as further source rows. Separate POs/deliverables
-- use separate instruction keys and remain separate cases.
--
-- Observe mode: makesafe_intake_drafts.status remains authoritative and cases are
-- shadow records inspected through makesafe_intake_case_divergence.
-- Cutover, in a later gated unit: cases become classification/lineage authority;
-- drafts become extraction artifacts and gain a subordinate case link. A DB
-- single-row cutover flag, following makesafe_cron_settings, will own the switch.
-- This migration does not add or flip that runtime flag.
--
-- SUNSETS AFTER CUTOVER, NOT IN THIS PR
-- 1. buildIntakeDedupIndex/isDuplicateIntake become advisory classifiers; DB
--    instruction/source/live-identity keys become identity authority.
-- 2. Heuristic reconcile counters are replaced by the structural accounting view.
-- 3. makesafe_notify_log ref/message dedup is replaced by lineage-grain Mission 2
--    notification accounting.
-- 4. Board known_refs draft joins are replaced by case -> job/source joins.
-- No case identity is copied into jobs.metadata.
--
-- LINEAGE
-- Each non-root case has exactly one typed, immutable parent. The parent must
-- already exist and lineage_id is inherited. Roots point lineage_id to themselves.
-- This forest shape prevents cycles without a recursive graph trigger. Duplicate
-- cases must point directly to a non-duplicate lineage root. Reopens always use
-- case-model cycle parent.cycle + 1, independent of legacy reattend/cancel path
-- cycle behavior. The live identity key includes this case cycle.
--
-- BACKFILL
-- Backfill decisions must use provenance='backfill' and side_effects_suppressed.
-- Natural-key upserts use (org_id, instruction_key); a second run performs no
-- case/source/event writes and cannot emit notification/domain effects here.

-- Cases require every linked builder profile to carry the same org. Legacy
-- makesafe_companies rows predate org scoping and were left null, which would
-- make them permanently unlinkable once that check is strict. They belong to the
-- single existing tenant, so they are backfilled and the column is closed.
UPDATE public.makesafe_companies
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

ALTER TABLE public.makesafe_companies
  ALTER COLUMN org_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.makesafe_companies
  ALTER COLUMN org_id SET NOT NULL;

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

CREATE OR REPLACE FUNCTION public.makesafe_intake_provenance_valid(p_value jsonb)
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
        OR provenance ->> 'method' NOT IN (
          'deterministic', 'ai', 'human', 'maverick', 'backfill'
        )
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
    WHEN 'confirmed_live_job' THEN p_to_state IN ('blocked_live_job')
    WHEN 'blocked_live_job' THEN p_to_state IN ('confirmed_live_job', 'exception')
    WHEN 'exception' THEN p_to_state IN (
      'confirmed_live_job', 'blocked_live_job', 'accounted_non_wo'
    )
    WHEN 'accounted_non_wo' THEN p_to_state IN ('exception')
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.makesafe_intake_field_names_valid(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.makesafe_intake_provenance_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.makesafe_intake_case_transition_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_field_names_valid(text[]) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_provenance_valid(jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_case_transition_allowed(text, text) TO service_role, postgres;

CREATE TABLE IF NOT EXISTS public.makesafe_intake_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.organisations(id) ON DELETE RESTRICT,
  instruction_key text NOT NULL,

  lineage_id uuid NOT NULL,
  parent_case_id uuid,
  parent_relation text CHECK (parent_relation IN (
    'revision_of',
    'duplicate_of',
    'cancellation_of',
    'sibling_of',
    'reopen_of'
  )),
  cycle integer NOT NULL DEFAULT 1 CHECK (cycle > 0),

  -- company_id is the stable builder profile identity. company_key is the
  -- canonical matching key stamped by the one versioned normaliser. Raw builder
  -- text remains untouched even when company aliases/slugs drift.
  company_id uuid REFERENCES public.makesafe_companies(id) ON DELETE RESTRICT,
  company_slug_raw text,
  company_key text,
  external_ref_raw text,
  external_ref_canonical text,
  builder_wo_raw text,
  builder_wo_canonical text,
  builder_po_raw text,
  builder_po_canonical text,
  deliverable_ref_raw text,
  deliverable_ref_canonical text,
  wo_po_identity_key text,
  normaliser_version text NOT NULL,
  raw_identity_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,

  client_name text,
  client_phone text,
  client_email text,
  site_address text,
  site_suburb text,
  missing_fields text[] NOT NULL DEFAULT '{}',
  conflicting_fields jsonb NOT NULL DEFAULT '{}'::jsonb,

  state text NOT NULL CHECK (state IN (
    'confirmed_live_job',
    'blocked_live_job',
    'exception',
    'accounted_non_wo'
  )),
  reason_code text CHECK (reason_code IN (
    'cancellation',
    'duplicate',
    'revision',
    'unknown_builder',
    'non_makesafe',
    'ambiguous_scope',
    'below_identity_floor',
    'adapter_parse_failure',
    'conflicting_fields'
  )),
  blocked_reasons text[] NOT NULL DEFAULT '{}',
  job_id uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,

  -- is_authoritative is an evidence marker, not the future runtime cutover flag.
  -- It is monotonic false -> true so a post-cutover physical DROP can be refused.
  is_authoritative boolean NOT NULL DEFAULT false,
  side_effects_suppressed boolean NOT NULL DEFAULT false,
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  last_decision_provenance text NOT NULL CHECK (
    last_decision_provenance IN (
      'deterministic', 'ai', 'human', 'maverick', 'backfill'
    )
  ),
  last_decision_actor text NOT NULL,
  last_decision_reason text NOT NULL,
  last_decision_at timestamptz NOT NULL DEFAULT now(),

  received_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_cases_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT makesafe_intake_cases_instruction_key
    UNIQUE (org_id, instruction_key),
  CONSTRAINT makesafe_intake_cases_lineage_shape_check CHECK (
    (parent_case_id IS NULL) = (parent_relation IS NULL)
  ),
  CONSTRAINT makesafe_intake_cases_no_self_parent_check CHECK (
    parent_case_id IS NULL OR parent_case_id <> id
  ),
  CONSTRAINT makesafe_intake_cases_lineage_fk
    FOREIGN KEY (org_id, lineage_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_cases_parent_fk
    FOREIGN KEY (org_id, parent_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_cases_values_present_check CHECK (
    btrim(instruction_key) <> ''
    AND btrim(normaliser_version) <> ''
    AND btrim(last_decision_actor) <> ''
    AND btrim(last_decision_reason) <> ''
  ),
  CONSTRAINT makesafe_intake_cases_company_identity_check CHECK (
    (company_id IS NULL) = (company_key IS NULL)
  ),
  CONSTRAINT makesafe_intake_cases_json_shapes_check CHECK (
    jsonb_typeof(raw_identity_json) = 'object'
    AND public.makesafe_intake_provenance_valid(field_provenance)
    AND jsonb_typeof(conflicting_fields) = 'object'
    AND (
      (
        company_key IS NULL
        AND external_ref_canonical IS NULL
        AND builder_wo_canonical IS NULL
        AND builder_po_canonical IS NULL
        AND deliverable_ref_canonical IS NULL
        AND wo_po_identity_key IS NULL
      )
      OR field_provenance <> '{}'::jsonb
    )
  ),
  -- wo_po_identity_key is the sole discriminator of the S13 live-uniqueness
  -- index, so it is not free text: it must be exactly the WO/PO precedence
  -- composition of the canonical columns. A mis-stamped key that would silently
  -- split or collapse live identity is rejected by the database.
  CONSTRAINT makesafe_intake_cases_wo_po_identity_key_check CHECK (
    wo_po_identity_key IS NOT DISTINCT FROM CASE
      WHEN builder_wo_canonical IS NOT NULL AND builder_po_canonical IS NOT NULL
        THEN 'wo:' || builder_wo_canonical || '/po:' || builder_po_canonical
      WHEN builder_po_canonical IS NOT NULL
        THEN 'po:' || builder_po_canonical
      WHEN builder_wo_canonical IS NOT NULL
        THEN 'wo:' || builder_wo_canonical
      ELSE NULL
    END
  ),
  -- The instruction key carries its own cycle so a reopen whose deterministic
  -- content matches the original can still insert under UNIQUE(org_id,
  -- instruction_key). The cycle column is assigned by the write trigger, so the
  -- key's cycle component must agree with it or the caller has guessed a cycle
  -- and silently reintroduced the collision the component exists to prevent.
  CONSTRAINT makesafe_intake_cases_instruction_key_cycle_check CHECK (
    right(instruction_key, length('/cycle:' || cycle::text))
      = '/cycle:' || cycle::text
  ),
  -- wo_po_identity_key is composed by concatenating the canonical WO and PO
  -- around a '/po:' separator. Keeping those separator characters out of the
  -- canonical components is what makes that composition injective.
  CONSTRAINT makesafe_intake_cases_canonical_separator_check CHECK (
    (builder_wo_canonical IS NULL OR builder_wo_canonical !~ '[/:]')
    AND (builder_po_canonical IS NULL OR builder_po_canonical !~ '[/:]')
  ),
  CONSTRAINT makesafe_intake_cases_field_names_check CHECK (
    public.makesafe_intake_field_names_valid(missing_fields)
    AND public.makesafe_intake_field_names_valid(blocked_reasons)
  ),
  CONSTRAINT makesafe_intake_cases_live_identity_floor_check CHECK (
    state NOT IN ('confirmed_live_job', 'blocked_live_job')
    OR (
      company_id IS NOT NULL
      AND COALESCE(
        external_ref_canonical,
        builder_wo_canonical,
        builder_po_canonical
      ) IS NOT NULL
      AND client_name IS NOT NULL
      AND site_address IS NOT NULL
    )
  ),
  CONSTRAINT makesafe_intake_cases_confirmed_shape_check CHECK (
    state <> 'confirmed_live_job'
    OR (
      job_id IS NOT NULL
      AND cardinality(blocked_reasons) = 0
      AND reason_code IS NULL
    )
  ),
  CONSTRAINT makesafe_intake_cases_blocked_shape_check CHECK (
    state <> 'blocked_live_job'
    OR (
      job_id IS NOT NULL
      AND cardinality(blocked_reasons) > 0
      AND reason_code IS NULL
    )
  ),
  CONSTRAINT makesafe_intake_cases_exception_shape_check CHECK (
    state <> 'exception'
    OR (
      job_id IS NULL
      AND cardinality(blocked_reasons) = 0
      AND reason_code IS NOT NULL
    )
  ),
  CONSTRAINT makesafe_intake_cases_non_wo_shape_check CHECK (
    state <> 'accounted_non_wo'
    OR (
      job_id IS NULL
      AND cardinality(blocked_reasons) = 0
      AND reason_code IS NOT NULL
    )
  ),
  CONSTRAINT makesafe_intake_cases_cancellation_no_job_check CHECK (
    reason_code IS DISTINCT FROM 'cancellation' OR job_id IS NULL
  ),
  CONSTRAINT makesafe_intake_cases_backfill_suppression_check CHECK (
    last_decision_provenance <> 'backfill' OR side_effects_suppressed
  )
);

-- S13-safe live identity. Claim/external ref is deliberately absent. A WO/PO
-- identity is unique only within builder, deliverable and case-model cycle, the
-- same discriminators the claim-ref fallback index below uses. Separate POs,
-- separate deliverables and reopened cycles do not collide. Unknown identity
-- remains a visible exception.
CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_intake_cases_live_identity
  ON public.makesafe_intake_cases (
    org_id,
    company_key,
    wo_po_identity_key,
    COALESCE(deliverable_ref_canonical, ''),
    cycle
  )
  WHERE state IN ('confirmed_live_job', 'blocked_live_job')
    AND company_key IS NOT NULL
    AND wo_po_identity_key IS NOT NULL;

-- The live identity floor also admits a claim-ref-only live case, which carries
-- no wo_po_identity_key and so escapes the index above entirely. Those cases get
-- their own fallback uniqueness on the canonical claim ref, still discriminated
-- by deliverable and cycle so separate deliverables and reopens stay separate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_intake_cases_live_claim_identity
  ON public.makesafe_intake_cases (
    org_id,
    company_key,
    external_ref_canonical,
    COALESCE(deliverable_ref_canonical, ''),
    cycle
  )
  WHERE state IN ('confirmed_live_job', 'blocked_live_job')
    AND company_key IS NOT NULL
    AND wo_po_identity_key IS NULL
    AND external_ref_canonical IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_intake_cases_job
  ON public.makesafe_intake_cases (org_id, job_id)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_makesafe_intake_cases_queue
  ON public.makesafe_intake_cases (org_id, state, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_makesafe_intake_cases_exception_queue
  ON public.makesafe_intake_cases (org_id, reason_code, received_at DESC)
  WHERE state = 'exception';
CREATE INDEX IF NOT EXISTS idx_makesafe_intake_cases_lineage
  ON public.makesafe_intake_cases (org_id, lineage_id, cycle);
CREATE INDEX IF NOT EXISTS idx_makesafe_intake_cases_canonical_identity
  ON public.makesafe_intake_cases (
    org_id,
    company_key,
    external_ref_canonical,
    builder_wo_canonical,
    builder_po_canonical,
    deliverable_ref_canonical
  );

CREATE TABLE IF NOT EXISTS public.makesafe_intake_case_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.organisations(id) ON DELETE RESTRICT,
  case_id uuid NOT NULL,
  post_id text NOT NULL REFERENCES public.emails(post_id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN (
    'original',
    'twin',
    'resend',
    'revision_notice',
    'cancellation_notice',
    'late_pdf'
  )),
  internet_message_id text,
  conversation_id text,
  thread_id text,
  attachment_refs uuid[] NOT NULL DEFAULT '{}',
  raw_identity_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance text NOT NULL CHECK (
    provenance IN ('deterministic', 'ai', 'human', 'maverick', 'backfill')
  ),
  received_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_case_sources_case_fk
    FOREIGN KEY (org_id, case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_sources_one_accounting_key
    UNIQUE (org_id, post_id),
  CONSTRAINT makesafe_intake_case_sources_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT makesafe_intake_case_sources_values_present_check
    CHECK (btrim(post_id) <> ''),
  CONSTRAINT makesafe_intake_case_sources_json_shapes_check CHECK (
    jsonb_typeof(raw_identity_json) = 'object'
    AND jsonb_typeof(evidence) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_case_sources_case
  ON public.makesafe_intake_case_sources (org_id, case_id, received_at);
CREATE INDEX IF NOT EXISTS idx_makesafe_intake_case_sources_internet_message
  ON public.makesafe_intake_case_sources (org_id, internet_message_id)
  WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_makesafe_intake_case_sources_conversation
  ON public.makesafe_intake_case_sources (org_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

COMMENT ON COLUMN public.makesafe_intake_case_sources.attachment_refs IS
  'Snapshot references to email_attachments.id only. No bytes, public URLs or signed URLs are stored here; attachment bytes remain in the existing private bucket.';

CREATE TABLE IF NOT EXISTS public.makesafe_intake_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.organisations(id) ON DELETE RESTRICT,
  case_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN (
    'initial_classification',
    'state_transition',
    'case_update',
    'authority_change',
    'identity_update'
  )),
  state_version integer NOT NULL CHECK (state_version > 0),
  from_state text,
  to_state text NOT NULL CHECK (to_state IN (
    'confirmed_live_job',
    'blocked_live_job',
    'exception',
    'accounted_non_wo'
  )),
  reason_code text,
  decision_provenance text NOT NULL CHECK (
    decision_provenance IN (
      'deterministic', 'ai', 'human', 'maverick', 'backfill'
    )
  ),
  decision_actor text NOT NULL,
  decision_reason text NOT NULL,
  missing_fields_snapshot text[] NOT NULL DEFAULT '{}',
  conflicting_fields_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocked_reasons_snapshot text[] NOT NULL DEFAULT '{}',
  side_effects_suppressed boolean NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_case_events_case_fk
    FOREIGN KEY (org_id, case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_events_values_present_check CHECK (
    btrim(decision_actor) <> '' AND btrim(decision_reason) <> ''
  ),
  CONSTRAINT makesafe_intake_case_events_json_shapes_check CHECK (
    jsonb_typeof(conflicting_fields_snapshot) = 'object'
    AND jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT makesafe_intake_case_events_backfill_suppression_check CHECK (
    decision_provenance <> 'backfill' OR side_effects_suppressed
  )
);

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_case_events_history
  ON public.makesafe_intake_case_events
  (org_id, case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_makesafe_intake_case_events_observed
  ON public.makesafe_intake_case_events (org_id, observed_at DESC);

CREATE OR REPLACE FUNCTION public.enforce_makesafe_intake_case_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_case public.makesafe_intake_cases%ROWTYPE;
  company_org_id uuid;
  identity_changed boolean := false;
  case_facts_changed boolean := false;
  decision_changed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.state_version := 1;
    NEW.last_decision_at := COALESCE(NEW.last_decision_at, now());

    IF NEW.parent_case_id IS NULL THEN
      IF NEW.parent_relation IS NOT NULL THEN
        RAISE EXCEPTION 'parent_case_id and parent_relation must be set together';
      END IF;
      IF NEW.lineage_id IS NOT NULL AND NEW.lineage_id <> NEW.id THEN
        RAISE EXCEPTION 'root case lineage_id must equal its id';
      END IF;
      NEW.lineage_id := NEW.id;
      IF NEW.cycle <> 1 THEN
        RAISE EXCEPTION 'root make-safe intake case cycle must be 1';
      END IF;
    ELSE
      IF NEW.parent_relation IS NULL THEN
        RAISE EXCEPTION 'parent_case_id and parent_relation must be set together';
      END IF;
      SELECT * INTO parent_case
      FROM public.makesafe_intake_cases parent
      WHERE parent.org_id = NEW.org_id
        AND parent.id = NEW.parent_case_id
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'lineage parent must already exist in the same org';
      END IF;
      IF NEW.lineage_id IS NOT NULL
        AND NEW.lineage_id <> parent_case.lineage_id
      THEN
        RAISE EXCEPTION 'child lineage_id must equal the parent lineage';
      END IF;
      NEW.lineage_id := parent_case.lineage_id;
      NEW.cycle := CASE
        WHEN NEW.parent_relation = 'reopen_of' THEN parent_case.cycle + 1
        ELSE parent_case.cycle
      END;

      IF NEW.parent_relation = 'duplicate_of' AND (
        parent_case.id <> parent_case.lineage_id
        OR parent_case.reason_code = 'duplicate'
      ) THEN
        RAISE EXCEPTION 'duplicate_of must point directly to a non-duplicate lineage root';
      END IF;
    END IF;
  ELSE
    IF NEW.org_id IS DISTINCT FROM OLD.org_id
      OR NEW.instruction_key IS DISTINCT FROM OLD.instruction_key
      OR NEW.lineage_id IS DISTINCT FROM OLD.lineage_id
      OR NEW.parent_case_id IS DISTINCT FROM OLD.parent_case_id
      OR NEW.parent_relation IS DISTINCT FROM OLD.parent_relation
      OR NEW.cycle IS DISTINCT FROM OLD.cycle
    THEN
      RAISE EXCEPTION 'case instruction and lineage identity are immutable';
    END IF;

    IF (OLD.company_slug_raw IS NOT NULL AND NEW.company_slug_raw IS DISTINCT FROM OLD.company_slug_raw)
      OR (OLD.external_ref_raw IS NOT NULL AND NEW.external_ref_raw IS DISTINCT FROM OLD.external_ref_raw)
      OR (OLD.builder_wo_raw IS NOT NULL AND NEW.builder_wo_raw IS DISTINCT FROM OLD.builder_wo_raw)
      OR (OLD.builder_po_raw IS NOT NULL AND NEW.builder_po_raw IS DISTINCT FROM OLD.builder_po_raw)
      OR (OLD.deliverable_ref_raw IS NOT NULL AND NEW.deliverable_ref_raw IS DISTINCT FROM OLD.deliverable_ref_raw)
      OR (
        OLD.raw_identity_json <> '{}'::jsonb
        AND NEW.raw_identity_json IS DISTINCT FROM OLD.raw_identity_json
      )
    THEN
      RAISE EXCEPTION 'raw identity values cannot be replaced or cleared';
    END IF;

    identity_changed :=
      NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.company_key IS DISTINCT FROM OLD.company_key
      OR NEW.external_ref_canonical IS DISTINCT FROM OLD.external_ref_canonical
      OR NEW.builder_wo_canonical IS DISTINCT FROM OLD.builder_wo_canonical
      OR NEW.builder_po_canonical IS DISTINCT FROM OLD.builder_po_canonical
      OR NEW.deliverable_ref_canonical IS DISTINCT FROM OLD.deliverable_ref_canonical
      OR NEW.wo_po_identity_key IS DISTINCT FROM OLD.wo_po_identity_key
      OR NEW.normaliser_version IS DISTINCT FROM OLD.normaliser_version;

    IF NOT NEW.field_provenance @> OLD.field_provenance THEN
      RAISE EXCEPTION 'field provenance is append-only';
    END IF;
    IF identity_changed
      AND NEW.field_provenance IS NOT DISTINCT FROM OLD.field_provenance
    THEN
      RAISE EXCEPTION 'canonical identity changes require appended field provenance';
    END IF;

    IF OLD.is_authoritative AND NOT NEW.is_authoritative THEN
      RAISE EXCEPTION 'authoritative case evidence cannot be demoted';
    END IF;

    case_facts_changed :=
      NEW.reason_code IS DISTINCT FROM OLD.reason_code
      OR NEW.blocked_reasons IS DISTINCT FROM OLD.blocked_reasons
      OR NEW.job_id IS DISTINCT FROM OLD.job_id
      OR NEW.client_name IS DISTINCT FROM OLD.client_name
      OR NEW.client_phone IS DISTINCT FROM OLD.client_phone
      OR NEW.client_email IS DISTINCT FROM OLD.client_email
      OR NEW.site_address IS DISTINCT FROM OLD.site_address
      OR NEW.site_suburb IS DISTINCT FROM OLD.site_suburb
      OR NEW.missing_fields IS DISTINCT FROM OLD.missing_fields
      OR NEW.conflicting_fields IS DISTINCT FROM OLD.conflicting_fields
      OR NEW.side_effects_suppressed IS DISTINCT FROM OLD.side_effects_suppressed;
    decision_changed :=
      NEW.state IS DISTINCT FROM OLD.state
      OR identity_changed
      OR case_facts_changed
      OR NEW.is_authoritative IS DISTINCT FROM OLD.is_authoritative;

    IF NEW.state IS DISTINCT FROM OLD.state THEN
      IF NOT public.makesafe_intake_case_transition_allowed(OLD.state, NEW.state) THEN
        RAISE EXCEPTION 'invalid make-safe intake case transition: % -> %',
          OLD.state, NEW.state;
      END IF;
      NEW.state_version := OLD.state_version + 1;
    ELSIF NEW.state_version IS DISTINCT FROM OLD.state_version THEN
      RAISE EXCEPTION 'state_version changes only with state';
    END IF;

    IF decision_changed THEN
      IF NEW.last_decision_reason IS NOT DISTINCT FROM OLD.last_decision_reason THEN
        RAISE EXCEPTION 'case decisions require a new decision reason';
      END IF;
      NEW.last_decision_at := now();
      NEW.observed_at := now();
    ELSIF NEW.last_decision_provenance IS DISTINCT FROM OLD.last_decision_provenance
      OR NEW.last_decision_actor IS DISTINCT FROM OLD.last_decision_actor
      OR NEW.last_decision_reason IS DISTINCT FROM OLD.last_decision_reason
      OR NEW.last_decision_at IS DISTINCT FROM OLD.last_decision_at
    THEN
      RAISE EXCEPTION 'decision metadata may change only with an audited case decision';
    END IF;
    NEW.updated_at := now();
  END IF;

  IF NEW.company_id IS NOT NULL THEN
    SELECT company.org_id INTO company_org_id
    FROM public.makesafe_companies company
    WHERE company.id = NEW.company_id;
    IF NOT FOUND OR company_org_id IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'company_id must reference the same org';
    END IF;
    IF NEW.company_key IS NULL OR NEW.company_key <> 'company:' || NEW.company_id::text THEN
      RAISE EXCEPTION 'company_key must be derived from company_id';
    END IF;
  END IF;

  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.jobs job
    WHERE job.id = NEW.job_id
      AND job.org_id = NEW.org_id
      AND job.type = 'makesafe'
  ) THEN
    RAISE EXCEPTION 'job_id must reference a make-safe job in the same org';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_makesafe_intake_case_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  case_facts_changed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.makesafe_intake_case_events (
      org_id, case_id, event_kind, state_version, from_state, to_state,
      reason_code, decision_provenance, decision_actor, decision_reason,
      missing_fields_snapshot, conflicting_fields_snapshot,
      blocked_reasons_snapshot, side_effects_suppressed, observed_at
    ) VALUES (
      NEW.org_id, NEW.id, 'initial_classification', NEW.state_version, NULL,
      NEW.state, NEW.reason_code, NEW.last_decision_provenance,
      NEW.last_decision_actor, NEW.last_decision_reason, NEW.missing_fields,
      NEW.conflicting_fields, NEW.blocked_reasons,
      NEW.side_effects_suppressed, NEW.observed_at
    );
    RETURN NEW;
  END IF;

  case_facts_changed :=
    NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.blocked_reasons IS DISTINCT FROM OLD.blocked_reasons
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.client_name IS DISTINCT FROM OLD.client_name
    OR NEW.client_phone IS DISTINCT FROM OLD.client_phone
    OR NEW.client_email IS DISTINCT FROM OLD.client_email
    OR NEW.site_address IS DISTINCT FROM OLD.site_address
    OR NEW.site_suburb IS DISTINCT FROM OLD.site_suburb
    OR NEW.missing_fields IS DISTINCT FROM OLD.missing_fields
    OR NEW.conflicting_fields IS DISTINCT FROM OLD.conflicting_fields
    OR NEW.side_effects_suppressed IS DISTINCT FROM OLD.side_effects_suppressed;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO public.makesafe_intake_case_events (
      org_id, case_id, event_kind, state_version, from_state, to_state,
      reason_code, decision_provenance, decision_actor, decision_reason,
      missing_fields_snapshot, conflicting_fields_snapshot,
      blocked_reasons_snapshot, side_effects_suppressed, observed_at
    ) VALUES (
      NEW.org_id, NEW.id, 'state_transition', NEW.state_version, OLD.state,
      NEW.state, NEW.reason_code, NEW.last_decision_provenance,
      NEW.last_decision_actor, NEW.last_decision_reason, NEW.missing_fields,
      NEW.conflicting_fields, NEW.blocked_reasons,
      NEW.side_effects_suppressed, NEW.observed_at
    );
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state AND case_facts_changed THEN
    INSERT INTO public.makesafe_intake_case_events (
      org_id, case_id, event_kind, state_version, from_state, to_state,
      reason_code, decision_provenance, decision_actor, decision_reason,
      missing_fields_snapshot, conflicting_fields_snapshot,
      blocked_reasons_snapshot, side_effects_suppressed, observed_at
    ) VALUES (
      NEW.org_id, NEW.id, 'case_update', NEW.state_version, OLD.state,
      NEW.state, NEW.reason_code, NEW.last_decision_provenance,
      NEW.last_decision_actor, NEW.last_decision_reason, NEW.missing_fields,
      NEW.conflicting_fields, NEW.blocked_reasons,
      NEW.side_effects_suppressed, NEW.observed_at
    );
  END IF;

  IF NEW.is_authoritative IS DISTINCT FROM OLD.is_authoritative THEN
    INSERT INTO public.makesafe_intake_case_events (
      org_id, case_id, event_kind, state_version, from_state, to_state,
      reason_code, decision_provenance, decision_actor, decision_reason,
      missing_fields_snapshot, conflicting_fields_snapshot,
      blocked_reasons_snapshot, side_effects_suppressed, evidence, observed_at
    ) VALUES (
      NEW.org_id, NEW.id, 'authority_change', NEW.state_version, OLD.state,
      NEW.state, NEW.reason_code, NEW.last_decision_provenance,
      NEW.last_decision_actor, NEW.last_decision_reason, NEW.missing_fields,
      NEW.conflicting_fields, NEW.blocked_reasons,
      NEW.side_effects_suppressed,
      jsonb_build_object('is_authoritative', NEW.is_authoritative),
      NEW.observed_at
    );
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.company_key IS DISTINCT FROM OLD.company_key
    OR NEW.external_ref_canonical IS DISTINCT FROM OLD.external_ref_canonical
    OR NEW.builder_wo_canonical IS DISTINCT FROM OLD.builder_wo_canonical
    OR NEW.builder_po_canonical IS DISTINCT FROM OLD.builder_po_canonical
    OR NEW.deliverable_ref_canonical IS DISTINCT FROM OLD.deliverable_ref_canonical
    OR NEW.wo_po_identity_key IS DISTINCT FROM OLD.wo_po_identity_key
    OR NEW.normaliser_version IS DISTINCT FROM OLD.normaliser_version
  THEN
    INSERT INTO public.makesafe_intake_case_events (
      org_id, case_id, event_kind, state_version, from_state, to_state,
      reason_code, decision_provenance, decision_actor, decision_reason,
      missing_fields_snapshot, conflicting_fields_snapshot,
      blocked_reasons_snapshot, side_effects_suppressed, evidence, observed_at
    ) VALUES (
      NEW.org_id, NEW.id, 'identity_update', NEW.state_version, OLD.state,
      NEW.state, NEW.reason_code, NEW.last_decision_provenance,
      NEW.last_decision_actor, NEW.last_decision_reason, NEW.missing_fields,
      NEW.conflicting_fields, NEW.blocked_reasons,
      NEW.side_effects_suppressed,
      jsonb_build_object('normaliser_version', NEW.normaliser_version),
      NEW.observed_at
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_makesafe_intake_case_source_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF cardinality(NEW.attachment_refs) <> (
    SELECT count(DISTINCT attachment_id)
    FROM unnest(NEW.attachment_refs) AS item(attachment_id)
  ) THEN
    RAISE EXCEPTION 'attachment_refs must be unique and non-null';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.attachment_refs) AS item(attachment_id)
    WHERE attachment_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.email_attachments attachment
        WHERE attachment.id = attachment_id
          AND attachment.email_id = NEW.post_id
      )
  ) THEN
    RAISE EXCEPTION 'attachment_refs must belong to the source post';
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

DROP TRIGGER IF EXISTS trg_makesafe_intake_cases_enforce
  ON public.makesafe_intake_cases;
CREATE TRIGGER trg_makesafe_intake_cases_enforce
  BEFORE INSERT OR UPDATE ON public.makesafe_intake_cases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_makesafe_intake_case_write();

DROP TRIGGER IF EXISTS trg_makesafe_intake_cases_record_event
  ON public.makesafe_intake_cases;
CREATE TRIGGER trg_makesafe_intake_cases_record_event
  AFTER INSERT OR UPDATE ON public.makesafe_intake_cases
  FOR EACH ROW EXECUTE FUNCTION public.record_makesafe_intake_case_event();

DROP TRIGGER IF EXISTS trg_makesafe_intake_cases_no_delete
  ON public.makesafe_intake_cases;
CREATE TRIGGER trg_makesafe_intake_cases_no_delete
  BEFORE DELETE ON public.makesafe_intake_cases
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

DROP TRIGGER IF EXISTS trg_makesafe_intake_case_sources_enforce
  ON public.makesafe_intake_case_sources;
CREATE TRIGGER trg_makesafe_intake_case_sources_enforce
  BEFORE INSERT ON public.makesafe_intake_case_sources
  FOR EACH ROW EXECUTE FUNCTION public.enforce_makesafe_intake_case_source_insert();

DROP TRIGGER IF EXISTS trg_makesafe_intake_case_sources_append_only
  ON public.makesafe_intake_case_sources;
CREATE TRIGGER trg_makesafe_intake_case_sources_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_intake_case_sources
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

DROP TRIGGER IF EXISTS trg_makesafe_intake_case_events_append_only
  ON public.makesafe_intake_case_events;
CREATE TRIGGER trg_makesafe_intake_case_events_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_intake_case_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

-- Structural canary instrument. It compares shadow case state, current draft
-- state and job existence per attached source post without changing authority.
CREATE OR REPLACE VIEW public.makesafe_intake_case_divergence AS
SELECT
  source.org_id,
  source.case_id,
  source.post_id,
  source.role AS source_role,
  source.received_at,
  intake_case.lineage_id,
  intake_case.cycle,
  intake_case.state AS case_state,
  intake_case.reason_code,
  intake_case.is_authoritative,
  CASE
    WHEN intake_case.is_authoritative THEN 'case_authoritative'
    ELSE 'draft_authoritative_case_shadow'
  END AS authority_mode,
  draft.id AS draft_id,
  draft.status AS draft_status,
  draft.approved_job_id AS draft_job_id,
  intake_case.job_id AS case_job_id,
  (job.id IS NOT NULL) AS case_job_exists,
  CASE
    WHEN intake_case.state IN ('confirmed_live_job', 'blocked_live_job')
      AND job.id IS NULL
      THEN 'case_live_job_missing'
    WHEN intake_case.state IN ('confirmed_live_job', 'blocked_live_job')
      AND draft.id IS NOT NULL
      AND draft.status <> 'approved'
      THEN 'draft_not_approved_for_live_case'
    WHEN intake_case.state IN ('exception', 'accounted_non_wo')
      AND draft.status = 'approved'
      THEN 'draft_approved_but_case_non_live'
    WHEN intake_case.job_id IS NOT NULL
      AND draft.approved_job_id IS NOT NULL
      AND intake_case.job_id <> draft.approved_job_id
      THEN 'case_draft_job_mismatch'
    ELSE NULL
  END AS divergence_reason
FROM public.makesafe_intake_case_sources source
JOIN public.makesafe_intake_cases intake_case
  ON intake_case.org_id = source.org_id
 AND intake_case.id = source.case_id
LEFT JOIN public.makesafe_intake_drafts draft
  ON draft.org_id = source.org_id
 AND draft.graph_message_id = source.post_id
LEFT JOIN public.jobs job
  ON job.org_id = intake_case.org_id
 AND job.id = intake_case.job_id;

-- Structural reconcile, one uncapped row per captured email. Later U7 readers
-- consume this instead of capped ref/subject heuristics.
--
-- public.emails carries no org column, so accounting is only answerable for a
-- named tenant: the same post_id may legitimately be accounted by a case in more
-- than one org. This is a function rather than a view so the caller states the
-- org, the row grain stays exactly one row per captured email, and unaccounted
-- emails are attributed to the org that asked instead of a pinned literal.
DROP VIEW IF EXISTS public.makesafe_intake_email_accounting;

CREATE OR REPLACE FUNCTION public.makesafe_intake_email_accounting(p_org_id uuid)
RETURNS TABLE (
  org_id uuid,
  post_id text,
  mailbox text,
  received_at timestamptz,
  case_id uuid,
  case_state text,
  exclusion_reason text,
  accounting_status text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    p_org_id AS org_id,
    email.post_id,
    email.mailbox,
    email.received_at,
    source.case_id,
    intake_case.state AS case_state,
    exclusion.exclusion_reason,
    CASE
      WHEN source.case_id IS NOT NULL THEN 'case_accounted'
      WHEN exclusion.post_id IS NOT NULL THEN 'classifier_excluded'
      ELSE 'unaccounted'
    END AS accounting_status
  FROM public.emails email
  LEFT JOIN public.makesafe_intake_case_sources source
    ON source.post_id = email.post_id
   AND source.org_id = p_org_id
  LEFT JOIN public.makesafe_intake_cases intake_case
    ON intake_case.org_id = source.org_id
   AND intake_case.id = source.case_id
  LEFT JOIN public.email_classifier_exclusions exclusion
    ON exclusion.post_id = email.post_id;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'makesafe_intake_cases',
    'makesafe_intake_case_sources',
    'makesafe_intake_case_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', table_name);
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'service_role_all_' || table_name,
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'service_role_all_' || table_name,
      table_name
    );
  END LOOP;
END $$;

REVOKE ALL ON public.makesafe_intake_case_divergence FROM anon, authenticated;
GRANT SELECT ON public.makesafe_intake_case_divergence TO service_role;
REVOKE ALL ON FUNCTION public.makesafe_intake_email_accounting(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_email_accounting(uuid)
  TO service_role, postgres;

COMMENT ON TABLE public.makesafe_intake_cases IS
  'Canonical deterministic make-safe instruction case and sole future classification/lineage authority. Shadow-only until a later gated cutover.';
COMMENT ON TABLE public.makesafe_intake_case_sources IS
  'Append-only N:1 source email accounting. UNIQUE(org_id, post_id) structurally accounts each captured email once per tenant.';
COMMENT ON TABLE public.makesafe_intake_case_events IS
  'Trigger-fed append-only case decision ledger with deterministic, AI, human, Maverick and backfill provenance.';
COMMENT ON VIEW public.makesafe_intake_case_divergence IS
  'Parallel-observe canary comparison of case state, draft state and job existence per source post.';
COMMENT ON FUNCTION public.makesafe_intake_email_accounting(uuid) IS
  'Uncapped structural accounting of captured make-safe emails as case-accounted, classifier-excluded or unaccounted, for one named org.';

-- DOWN / ROLLBACK
-- supabase/rollbacks/20260720000001_makesafe_intake_cases_down.sql is physical
-- DROP only before cutover. It refuses when any case has is_authoritative=true.
-- After cutover, rollback is the later G5/G6 DB flag flip to the old pipeline;
-- this ledger remains inert evidence. Physical removal then requires separately
-- approved archive/rename, never this DROP script.
