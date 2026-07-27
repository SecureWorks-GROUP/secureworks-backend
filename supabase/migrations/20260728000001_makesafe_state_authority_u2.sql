-- SES Reporting U2 Phase 1: additive makesafe-state.v2 authority spine.
-- Default makesafe-board.v1 reads do not select any object added here.
-- No backfill, stage flip, operational status mutation, send, or destructive
-- schema change is performed by this migration.

-- Effective live schema still has eleven terminal rows carrying the legacy
-- pending_allocation value. PostgreSQL enforces a NOT VALID CHECK for every new
-- or updated row, so adding the six-value constraint here would break unrelated
-- updates to those live jobs. Phase 2 must convert the manifested rows first,
-- then replace the legacy seven-value constraint with the canonical six-value
-- constraint. Runtime v1 validation already accepts only the six canonical
-- write values; the compare projector reports pending_allocation as legacy.

-- Stable dependency identities are nullable until Phase 2. The v2 projector
-- treats any missing version/hash as projection_input_error; it never guesses.
ALTER TABLE public.makesafe_intake_cases
  ADD COLUMN IF NOT EXISTS source_version bigint,
  ADD COLUMN IF NOT EXISTS source_content_hash text,
  ADD COLUMN IF NOT EXISTS lineage_version bigint,
  ADD COLUMN IF NOT EXISTS lineage_correction_hash text,
  ADD COLUMN IF NOT EXISTS lineage_supersession_hash text;

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_u2_hashes_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_u2_hashes_check CHECK (
    (source_version IS NULL OR source_version > 0)
    AND (lineage_version IS NULL OR lineage_version > 0)
    AND (
      source_content_hash IS NULL
      OR source_content_hash ~ '^sha256:[0-9a-f]{64}$'
    )
    AND (
      lineage_correction_hash IS NULL
      OR lineage_correction_hash ~ '^sha256:[0-9a-f]{64}$'
    )
    AND (
      lineage_supersession_hash IS NULL
      OR lineage_supersession_hash ~ '^sha256:[0-9a-f]{64}$'
    )
  ) NOT VALID;

ALTER TABLE public.makesafe_attendance_cycles
  ADD COLUMN IF NOT EXISTS makesafe_fact_version bigint,
  ADD COLUMN IF NOT EXISTS makesafe_content_hash text;
ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS makesafe_fact_version bigint,
  ADD COLUMN IF NOT EXISTS makesafe_content_hash text;
ALTER TABLE public.job_service_reports
  ADD COLUMN IF NOT EXISTS makesafe_fact_version bigint,
  ADD COLUMN IF NOT EXISTS makesafe_content_hash text;
ALTER TABLE public.job_media
  ADD COLUMN IF NOT EXISTS attendance_cycle_id uuid
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cycle_attribution text,
  ADD COLUMN IF NOT EXISTS makesafe_fact_version bigint,
  ADD COLUMN IF NOT EXISTS makesafe_content_hash text;
ALTER TABLE public.job_documents
  ADD COLUMN IF NOT EXISTS attendance_cycle_id uuid
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cycle_attribution text,
  ADD COLUMN IF NOT EXISTS makesafe_fact_version bigint,
  ADD COLUMN IF NOT EXISTS makesafe_content_hash text;
ALTER TABLE public.makesafe_report_packs
  ADD COLUMN IF NOT EXISTS makesafe_fact_version bigint,
  ADD COLUMN IF NOT EXISTS makesafe_content_hash text;

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
    'makesafe_report_packs'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      relation_name,
      relation_name || '_u2_fact_identity_check'
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
         (makesafe_fact_version IS NULL OR makesafe_fact_version > 0)
         AND (
           makesafe_content_hash IS NULL
           OR makesafe_content_hash ~ ''^sha256:[0-9a-f]{64}$''
         )
       ) NOT VALID',
      relation_name,
      relation_name || '_u2_fact_identity_check'
    );
  END LOOP;
END;
$$;

ALTER TABLE public.job_media
  DROP CONSTRAINT IF EXISTS job_media_u2_cycle_attribution_check;
ALTER TABLE public.job_media
  ADD CONSTRAINT job_media_u2_cycle_attribution_check CHECK (
    cycle_attribution IS NULL OR cycle_attribution IN (
      'bound', 'backfill_cycle_scope', 'legacy_unscoped'
    )
  ) NOT VALID;
ALTER TABLE public.job_documents
  DROP CONSTRAINT IF EXISTS job_documents_u2_cycle_attribution_check;
ALTER TABLE public.job_documents
  ADD CONSTRAINT job_documents_u2_cycle_attribution_check CHECK (
    cycle_attribution IS NULL OR cycle_attribution IN (
      'bound', 'backfill_cycle_scope', 'legacy_unscoped'
    )
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_job_media_makesafe_attendance_cycle
  ON public.job_media (job_id, attendance_cycle_id)
  WHERE attendance_cycle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_documents_makesafe_attendance_cycle
  ON public.job_documents (job_id, attendance_cycle_id)
  WHERE attendance_cycle_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.makesafe_state_projection_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  default_contract_version text NOT NULL DEFAULT 'v1'
    CHECK (default_contract_version IN ('v1', 'v2')),
  compare_enabled boolean NOT NULL DEFAULT true,
  authority_flipped boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'migration',
  CONSTRAINT makesafe_state_projection_config_phase_check CHECK (
    authority_flipped = false OR default_contract_version = 'v2'
  )
);
INSERT INTO public.makesafe_state_projection_config (
  singleton,
  default_contract_version,
  compare_enabled,
  authority_flipped,
  updated_by
) VALUES (true, 'v1', true, false, '20260728000001')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.makesafe_family_rule_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_code text NOT NULL CHECK (length(btrim(family_code)) > 0),
  family_kind text NOT NULL CHECK (
    family_kind IN ('physical', 'portal', 'report_only')
  ),
  matrix_revision text NOT NULL CHECK (length(btrim(matrix_revision)) > 0),
  matrix_content_hash text NOT NULL
    CHECK (matrix_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  completion_photo_floor integer NOT NULL DEFAULT 5
    CHECK (completion_photo_floor >= 0),
  required_document_types text[] NOT NULL DEFAULT '{}',
  required_portal_roles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  UNIQUE (family_code, matrix_revision)
);

CREATE TABLE IF NOT EXISTS public.makesafe_family_rule_current (
  family_code text PRIMARY KEY,
  revision_id uuid NOT NULL UNIQUE
    REFERENCES public.makesafe_family_rule_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) > 0)
);

CREATE TABLE IF NOT EXISTS public.makesafe_portal_capture_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  attendance_cycle_id uuid NOT NULL
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (length(btrim(role)) > 0),
  status text NOT NULL CHECK (status IN ('captured', 'verified', 'rejected')),
  makesafe_fact_version bigint NOT NULL CHECK (makesafe_fact_version > 0),
  makesafe_content_hash text NOT NULL
    CHECK (makesafe_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  UNIQUE (job_id, attendance_cycle_id, role, makesafe_fact_version)
);

CREATE TABLE IF NOT EXISTS public.makesafe_readiness_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  readiness_revision text NOT NULL
    CHECK (readiness_revision ~ '^sha256:[0-9a-f]{64}$'),
  algorithm text NOT NULL DEFAULT 'sha256' CHECK (algorithm = 'sha256'),
  dependency_generation bigint NOT NULL CHECK (dependency_generation >= 0),
  attendance_cycle_set_hash text NOT NULL
    CHECK (attendance_cycle_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  family_matrix_revision text NOT NULL,
  dependency_envelope jsonb NOT NULL
    CHECK (jsonb_typeof(dependency_envelope) = 'object'),
  ready boolean NOT NULL DEFAULT false,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(blockers) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'system',
  UNIQUE (job_id, readiness_revision)
);

CREATE TABLE IF NOT EXISTS public.makesafe_readiness_current (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE RESTRICT,
  org_id uuid NOT NULL,
  dependency_generation bigint NOT NULL DEFAULT 0
    CHECK (dependency_generation >= 0),
  readiness_revision text,
  attendance_cycle_set_hash text
    CHECK (
      attendance_cycle_set_hash IS NULL
      OR attendance_cycle_set_hash ~ '^sha256:[0-9a-f]{64}$'
    ),
  family_matrix_revision text,
  ready boolean NOT NULL DEFAULT false,
  invalidated_at timestamptz,
  invalidation_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_readiness_current_revision_shape CHECK (
    (readiness_revision IS NULL AND ready = false)
    OR readiness_revision ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT makesafe_readiness_current_revision_fk
    FOREIGN KEY (job_id, readiness_revision)
    REFERENCES public.makesafe_readiness_revisions(job_id, readiness_revision)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.makesafe_readiness_invalidations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  generation_before bigint NOT NULL CHECK (generation_before >= 0),
  generation_after bigint NOT NULL CHECK (
    generation_after = generation_before + 1
  ),
  dependency_kind text NOT NULL CHECK (length(btrim(dependency_kind)) > 0),
  dependency_identity text NOT NULL
    CHECK (length(btrim(dependency_identity)) > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  invalidated_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  UNIQUE (job_id, generation_after)
);

CREATE TABLE IF NOT EXISTS public.makesafe_revision_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (
    action IN ('pack_review', 'invoice', 'release', 'closeout')
  ),
  decision text NOT NULL CHECK (
    decision IN ('approved', 'rejected', 'revoked')
  ),
  readiness_revision text NOT NULL
    CHECK (readiness_revision ~ '^sha256:[0-9a-f]{64}$'),
  dependency_generation bigint NOT NULL CHECK (dependency_generation >= 0),
  docket_revision_id uuid,
  release_revision_id uuid,
  decided_by text NOT NULL CHECK (length(btrim(decided_by)) > 0),
  decided_at timestamptz NOT NULL DEFAULT now(),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_refs) = 'array')
);

CREATE TABLE IF NOT EXISTS public.makesafe_cancellation_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  attendance_cycle_set_hash text NOT NULL
    CHECK (attendance_cycle_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('requested', 'confirmed', 'rescinded')),
  reason_code text,
  note text,
  supersedes_id uuid REFERENCES public.makesafe_cancellation_decisions(id)
    ON DELETE RESTRICT,
  decided_by text NOT NULL CHECK (length(btrim(decided_by)) > 0),
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_cancellation_no_self_supersession
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE TABLE IF NOT EXISTS public.makesafe_terminal_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN (
    'release_closeout',
    'verified_historical_closeout',
    'approved_nonwork_archive'
  )),
  attendance_cycle_ids uuid[] NOT NULL
    CHECK (cardinality(attendance_cycle_ids) > 0),
  attendance_cycle_set_hash text NOT NULL
    CHECK (attendance_cycle_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  readiness_revision text
    CHECK (
      readiness_revision IS NULL
      OR readiness_revision ~ '^sha256:[0-9a-f]{64}$'
    ),
  release_revision_id uuid,
  closeout_revision_id uuid,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(evidence_refs) = 'array'
      AND jsonb_array_length(evidence_refs) > 0
    ),
  proven_by text NOT NULL CHECK (length(btrim(proven_by)) > 0),
  proven_at timestamptz NOT NULL DEFAULT now()
);

-- Typed holds are additive compatibility columns. Existing reason_code/note
-- rows remain valid and are migrated only in Phase 2.
ALTER TABLE public.makesafe_status_holds
  ADD COLUMN IF NOT EXISTS blocker_code text,
  ADD COLUMN IF NOT EXISTS owner_role text,
  ADD COLUMN IF NOT EXISTS recovery_action text,
  ADD COLUMN IF NOT EXISTS recovery_instruction text,
  ADD COLUMN IF NOT EXISTS evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS blocker_source text;
ALTER TABLE public.makesafe_status_holds
  DROP CONSTRAINT IF EXISTS makesafe_status_holds_u2_typed_check;
ALTER TABLE public.makesafe_status_holds
  ADD CONSTRAINT makesafe_status_holds_u2_typed_check CHECK (
    (
      blocker_code IS NULL
      AND owner_role IS NULL
      AND recovery_action IS NULL
      AND recovery_instruction IS NULL
      AND blocker_source IS NULL
    )
    OR (
      blocker_code IN (
        'intake_exception', 'missing_job_binding',
        'company_contact_required', 'no_current_cycle_assignment',
        'backfill_cycle_scope', 'missing_current_cycle_report',
        'missing_current_cycle_photos', 'missing_portal_capture',
        'missing_family_rule', 'missing_pricing_disposition',
        'missing_invoice_obligation_revision', 'missing_pack_revision',
        'stale_readiness_revision', 'stale_approval',
        'money_review_required', 'cancellation_review_required',
        'terminal_proof_required', 'projection_input_error'
      )
      AND owner_role IN ('ops', 'trade', 'captain', 'system')
      AND recovery_action IN (
        'resolve_intake_exception', 'review_cancellation',
        'resolve_blocker', 'contact_company', 'allocate_trade',
        'submit_trade_report', 'bind_cycle_evidence', 'prepare_docket',
        'review_docs', 'approve_invoice', 'approve_release',
        'execute_release', 'verify_closeout', 'none'
      )
      AND length(btrim(recovery_instruction)) > 0
      AND blocker_source = 'operator'
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.reject_makesafe_state_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DO $$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'makesafe_family_rule_revisions',
    'makesafe_portal_capture_revisions',
    'makesafe_readiness_revisions',
    'makesafe_readiness_invalidations',
    'makesafe_revision_approvals',
    'makesafe_cancellation_decisions',
    'makesafe_terminal_proofs'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON public.%I',
      'trg_' || relation_name || '_append_only',
      relation_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_state_audit_mutation()',
      'trg_' || relation_name || '_append_only',
      relation_name
    );
  END LOOP;
END;
$$;

-- Independent SQL canonical serializer used by the commit RPC and golden tests.
CREATE OR REPLACE FUNCTION public.makesafe_canonical_json_v1(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $$
DECLARE
  value_type text := jsonb_typeof(p_value);
  result text;
BEGIN
  IF value_type = 'null' THEN
    RETURN 'null';
  ELSIF value_type = 'string' THEN
    RETURN to_jsonb(normalize(p_value #>> '{}', NFC))::text;
  ELSIF value_type = 'boolean' THEN
    RETURN p_value::text;
  ELSIF value_type = 'number' THEN
    IF p_value::text !~ '^-?(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'readiness numbers must be finite base-10 integers';
    END IF;
    RETURN p_value::text;
  ELSIF value_type = 'object' THEN
    SELECT '{' || COALESCE(string_agg(
      to_jsonb(normalize(key, NFC))::text || ':' ||
        public.makesafe_canonical_json_v1(value),
      ',' ORDER BY normalize(key, NFC) COLLATE "C"
    ), '') || '}'
    INTO result
    FROM jsonb_each(p_value);
    RETURN result;
  ELSIF value_type = 'array' THEN
    SELECT '[' || COALESCE(string_agg(
      public.makesafe_canonical_json_v1(value),
      ',' ORDER BY
        COALESCE(
          normalize(value->>'id', NFC),
          normalize(value->>'attendance_cycle_id', NFC),
          normalize(value->>'family_code', NFC),
          public.makesafe_canonical_json_v1(value)
        ) COLLATE "C"
    ), '') || ']'
    INTO result
    FROM jsonb_array_elements(p_value);
    RETURN result;
  END IF;
  RAISE EXCEPTION 'unsupported readiness JSON type %', value_type;
END;
$$;

CREATE OR REPLACE FUNCTION public.makesafe_readiness_revision_v1(
  p_dependency_envelope jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $$
  SELECT 'sha256:' || encode(
    extensions.digest(
      convert_to(
        'SecureWorks:make-safe-readiness:v1' || E'\n' ||
          public.makesafe_canonical_json_v1(p_dependency_envelope),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

-- The same minimal vector is committed in
-- makesafe_readiness_golden_vectors.json and independently verified by
-- TypeScript and Python. Migration apply aborts if SQL canonical bytes drift.
DO $$
DECLARE
  v_envelope jsonb := $vector$
    {
      "source_instruction":{"id":"instruction-1","version":1,"content_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
      "lineage":{"lineage_id":"lineage-1","case_id":"case-1","version":1,"correction_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","supersession_hash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
      "attendance":{"attendance_cycle_ids":["cycle-1"],"current_attendance_cycle_id":"cycle-1","attendance_cycle_set_hash":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","cycles":[{"id":"cycle-1","version":1,"content_hash":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}]},
      "current_cycle":{"assignments":[],"service_reports":[],"documents":[],"completion_photos":[],"portal_captures":[]},
      "family":{"code":"physical_makesafe","matrix_revision":"family-1","matrix_content_hash":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"},
      "pricing":{"disposition":"not_required","revision":"pricing-1"},
      "invoice_obligation":{"id":null,"revision":null},
      "docket":{"revision_id":null,"artifact_hash":null,"manifest_hash":null}
    }
  $vector$::jsonb;
BEGIN
  IF public.makesafe_readiness_revision_v1(v_envelope)
     <> 'sha256:feaf1d310fb67221d1844d130e72ac4d2fa91f0b305d72ad548e70f37f3d76c9' THEN
    RAISE EXCEPTION 'makesafe readiness SQL golden vector mismatch';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invalidate_makesafe_readiness(
  p_job_id uuid,
  p_dependency_kind text,
  p_dependency_identity text,
  p_reason text,
  p_actor text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_before bigint;
  v_after bigint;
BEGIN
  IF length(btrim(COALESCE(p_dependency_kind, ''))) = 0
     OR length(btrim(COALESCE(p_dependency_identity, ''))) = 0
     OR length(btrim(COALESCE(p_reason, ''))) = 0
     OR length(btrim(COALESCE(p_actor, ''))) = 0 THEN
    RAISE EXCEPTION 'dependency kind, identity, reason and actor are required';
  END IF;
  SELECT org_id INTO v_org_id
  FROM public.jobs
  WHERE id = p_job_id AND type = 'makesafe';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current make-safe job not found';
  END IF;

  INSERT INTO public.makesafe_readiness_current (job_id, org_id)
  VALUES (p_job_id, v_org_id)
  ON CONFLICT (job_id) DO NOTHING;

  SELECT dependency_generation INTO v_before
  FROM public.makesafe_readiness_current
  WHERE job_id = p_job_id
  FOR UPDATE;
  v_after := v_before + 1;

  UPDATE public.makesafe_readiness_current
  SET dependency_generation = v_after,
      readiness_revision = NULL,
      attendance_cycle_set_hash = NULL,
      family_matrix_revision = NULL,
      ready = false,
      invalidated_at = transaction_timestamp(),
      invalidation_reason = p_reason,
      updated_at = transaction_timestamp()
  WHERE job_id = p_job_id;

  INSERT INTO public.makesafe_readiness_invalidations (
    org_id, job_id, generation_before, generation_after,
    dependency_kind, dependency_identity, reason, actor
  ) VALUES (
    v_org_id, p_job_id, v_before, v_after,
    p_dependency_kind, p_dependency_identity, p_reason, p_actor
  );
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_makesafe_readiness(
  p_job_id uuid,
  p_expected_generation bigint,
  p_readiness_revision text,
  p_attendance_cycle_set_hash text,
  p_family_matrix_revision text,
  p_dependency_envelope jsonb,
  p_ready boolean,
  p_blockers jsonb,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_generation bigint;
  v_expected_revision text;
BEGIN
  SELECT org_id INTO v_org_id
  FROM public.jobs
  WHERE id = p_job_id AND type = 'makesafe';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current make-safe job not found';
  END IF;
  IF jsonb_typeof(p_dependency_envelope) <> 'object'
     OR jsonb_typeof(COALESCE(p_blockers, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'dependency envelope and blockers have invalid shapes';
  END IF;
  v_expected_revision :=
    public.makesafe_readiness_revision_v1(p_dependency_envelope);
  IF p_readiness_revision IS DISTINCT FROM v_expected_revision THEN
    RAISE EXCEPTION 'readiness revision does not match canonical envelope';
  END IF;
  IF p_attendance_cycle_set_hash IS DISTINCT FROM
       p_dependency_envelope #>> '{attendance,attendance_cycle_set_hash}' THEN
    RAISE EXCEPTION
      'attendance cycle set hash does not match canonical envelope';
  END IF;
  IF p_family_matrix_revision IS DISTINCT FROM
       p_dependency_envelope #>> '{family,matrix_revision}' THEN
    RAISE EXCEPTION 'family matrix revision does not match canonical envelope';
  END IF;

  INSERT INTO public.makesafe_readiness_current (job_id, org_id)
  VALUES (p_job_id, v_org_id)
  ON CONFLICT (job_id) DO NOTHING;
  SELECT dependency_generation INTO v_generation
  FROM public.makesafe_readiness_current
  WHERE job_id = p_job_id
  FOR UPDATE;
  IF v_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'readiness generation conflict: expected %, current %',
      p_expected_generation, v_generation
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.makesafe_readiness_revisions (
    org_id, job_id, readiness_revision, dependency_generation,
    attendance_cycle_set_hash, family_matrix_revision,
    dependency_envelope, ready, blockers, created_by
  ) VALUES (
    v_org_id, p_job_id, p_readiness_revision, v_generation,
    p_attendance_cycle_set_hash, p_family_matrix_revision,
    p_dependency_envelope, p_ready, COALESCE(p_blockers, '[]'::jsonb), p_actor
  )
  ON CONFLICT (job_id, readiness_revision) DO NOTHING;

  UPDATE public.makesafe_readiness_current
  SET readiness_revision = p_readiness_revision,
      attendance_cycle_set_hash = p_attendance_cycle_set_hash,
      family_matrix_revision = p_family_matrix_revision,
      ready = p_ready,
      invalidated_at = NULL,
      invalidation_reason = NULL,
      updated_at = transaction_timestamp()
  WHERE job_id = p_job_id
    AND dependency_generation = v_generation;
  RETURN jsonb_build_object(
    'success', true,
    'dependency_generation', v_generation,
    'readiness_revision', p_readiness_revision,
    'ready', p_ready
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.invalidate_makesafe_fact_dependency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id uuid;
  v_identity text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_job_id := OLD.job_id;
    v_identity := OLD.id::text;
  ELSE
    v_job_id := NEW.job_id;
    v_identity := NEW.id::text;
  END IF;
  IF v_job_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.jobs
    WHERE id = v_job_id AND type = 'makesafe'
  ) THEN
    PERFORM public.invalidate_makesafe_readiness(
      v_job_id,
      TG_TABLE_NAME,
      v_identity,
      TG_OP || ' changed a makesafe-state.v2 dependency',
      'db-trigger'
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

-- Every table-local material fact invalidates current readiness inside the same
-- transaction. Multi-table commands must call the same invalidation primitive
-- from their guarded RPC before commit.
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
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.invalidate_makesafe_fact_dependency()',
      'trg_' || relation_name || '_readiness_invalidate',
      relation_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.invalidate_makesafe_case_dependency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_job_id uuid;
  v_new_job_id uuid;
  v_case_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new_job_id := NEW.job_id;
    v_case_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_old_job_id := OLD.job_id;
    v_case_id := OLD.id;
  ELSE
    v_old_job_id := OLD.job_id;
    v_new_job_id := NEW.job_id;
    v_case_id := NEW.id;
  END IF;
  IF v_old_job_id IS NOT NULL THEN
    PERFORM public.invalidate_makesafe_readiness(
      v_old_job_id, 'makesafe_intake_cases', v_case_id::text,
      TG_OP || ' changed source or lineage authority', 'db-trigger'
    );
  END IF;
  IF v_new_job_id IS NOT NULL AND v_new_job_id IS DISTINCT FROM v_old_job_id THEN
    PERFORM public.invalidate_makesafe_readiness(
      v_new_job_id, 'makesafe_intake_cases', v_case_id::text,
      TG_OP || ' changed source or lineage authority', 'db-trigger'
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
DROP TRIGGER IF EXISTS trg_makesafe_intake_cases_readiness_invalidate
  ON public.makesafe_intake_cases;
CREATE TRIGGER trg_makesafe_intake_cases_readiness_invalidate
  AFTER INSERT OR UPDATE OR DELETE
  ON public.makesafe_intake_cases
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_makesafe_case_dependency();

CREATE OR REPLACE FUNCTION public.invalidate_makesafe_authority_dependency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'makesafe_intake_case_authority_corrections' THEN
    FOR v_job_id IN
      SELECT DISTINCT c.job_id
      FROM public.makesafe_intake_cases c
      WHERE c.id IN (NEW.legacy_case_id, NEW.effective_case_id)
        AND c.job_id IS NOT NULL
    LOOP
      PERFORM public.invalidate_makesafe_readiness(
        v_job_id, TG_TABLE_NAME, NEW.id::text,
        'append-only case authority correction changed', 'db-trigger'
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'makesafe_intake_source_authority_corrections' THEN
    FOR v_job_id IN
      SELECT DISTINCT job_id
      FROM (
        SELECT NEW.target_job_id AS job_id
        UNION ALL
        SELECT c.job_id
        FROM public.makesafe_intake_cases c
        WHERE c.id IN (NEW.legacy_case_id, NEW.effective_case_id)
      ) affected
      WHERE job_id IS NOT NULL
    LOOP
      PERFORM public.invalidate_makesafe_readiness(
        v_job_id, TG_TABLE_NAME, NEW.id::text,
        'append-only source authority correction changed', 'db-trigger'
      );
    END LOOP;
  ELSE
    FOR v_job_id IN
      SELECT DISTINCT c.job_id
      FROM public.makesafe_intake_cases c
      WHERE c.id IN (NEW.prior_authority_case_id, NEW.effective_case_id)
        AND c.job_id IS NOT NULL
    LOOP
      PERFORM public.invalidate_makesafe_readiness(
        v_job_id, TG_TABLE_NAME, NEW.id::text,
        'append-only source authority supersession changed', 'db-trigger'
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_makesafe_case_authority_readiness_invalidate
  ON public.makesafe_intake_case_authority_corrections;
CREATE TRIGGER trg_makesafe_case_authority_readiness_invalidate
  AFTER INSERT ON public.makesafe_intake_case_authority_corrections
  FOR EACH ROW
  EXECUTE FUNCTION public.invalidate_makesafe_authority_dependency();

CREATE OR REPLACE FUNCTION public.invalidate_makesafe_family_pointer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_family_code text;
  v_revision_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_family_code := OLD.family_code;
    v_revision_id := OLD.revision_id;
  ELSE
    v_family_code := NEW.family_code;
    v_revision_id := NEW.revision_id;
  END IF;

  -- Family coding is not yet a stable relational job key. Invalidation is
  -- deliberately broad rather than risking a partial family match: every
  -- existing readiness pointer loses authority in the same transaction.
  PERFORM 1
  FROM public.makesafe_readiness_current
  FOR UPDATE;

  INSERT INTO public.makesafe_readiness_invalidations (
    org_id, job_id, generation_before, generation_after,
    dependency_kind, dependency_identity, reason, actor
  )
  SELECT
    c.org_id,
    c.job_id,
    c.dependency_generation,
    c.dependency_generation + 1,
    'makesafe_family_rule_current',
    v_family_code || ':' || v_revision_id::text,
    'family matrix current pointer changed',
    'db-trigger'
  FROM public.makesafe_readiness_current c;

  UPDATE public.makesafe_readiness_current
  SET dependency_generation = dependency_generation + 1,
      readiness_revision = NULL,
      attendance_cycle_set_hash = NULL,
      family_matrix_revision = NULL,
      ready = false,
      invalidated_at = transaction_timestamp(),
      invalidation_reason = 'family matrix current pointer changed',
      updated_at = transaction_timestamp();
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
DROP TRIGGER IF EXISTS trg_makesafe_family_pointer_readiness_invalidate
  ON public.makesafe_family_rule_current;
CREATE TRIGGER trg_makesafe_family_pointer_readiness_invalidate
  AFTER INSERT OR UPDATE OR DELETE ON public.makesafe_family_rule_current
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_makesafe_family_pointer();
DROP TRIGGER IF EXISTS trg_makesafe_source_authority_readiness_invalidate
  ON public.makesafe_intake_source_authority_corrections;
CREATE TRIGGER trg_makesafe_source_authority_readiness_invalidate
  AFTER INSERT ON public.makesafe_intake_source_authority_corrections
  FOR EACH ROW
  EXECUTE FUNCTION public.invalidate_makesafe_authority_dependency();
DROP TRIGGER IF EXISTS trg_makesafe_authority_supersession_readiness_invalidate
  ON public.makesafe_intake_source_authority_correction_supersessions;
CREATE TRIGGER trg_makesafe_authority_supersession_readiness_invalidate
  AFTER INSERT
  ON public.makesafe_intake_source_authority_correction_supersessions
  FOR EACH ROW
  EXECUTE FUNCTION public.invalidate_makesafe_authority_dependency();

CREATE OR REPLACE FUNCTION public.makesafe_attendance_cycle_set_hash_v1(
  p_attendance_cycle_ids uuid[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $$
  SELECT 'sha256:' || encode(
    extensions.digest(
      convert_to(
        'SecureWorks:make-safe-attendance-cycle-set:v1' || E'\n[' ||
          COALESCE(
            string_agg(
              to_jsonb(cycle_id::text)::text,
              ',' ORDER BY cycle_id::text COLLATE "C"
            ),
            ''
          ) || ']',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  FROM unnest(p_attendance_cycle_ids) AS cycles(cycle_id);
$$;

DO $$
BEGIN
  IF public.makesafe_attendance_cycle_set_hash_v1(ARRAY[
       '00000000-0000-0000-0000-000000000102'::uuid,
       '00000000-0000-0000-0000-000000000101'::uuid
     ]) <>
     'sha256:ea837da72d6a80810ebd5116945ea2a47736eaa5354164a12e58585ddda25690' THEN
    RAISE EXCEPTION 'makesafe attendance-cycle SQL golden vector mismatch';
  END IF;
END;
$$;

CREATE OR REPLACE VIEW public.makesafe_readiness_current_v2
WITH (security_invoker = true)
AS
SELECT
  c.job_id,
  c.org_id,
  c.dependency_generation,
  c.readiness_revision,
  c.attendance_cycle_set_hash,
  c.family_matrix_revision,
  COALESCE((
    c.ready
    AND r.ready
    AND r.attendance_cycle_set_hash = c.attendance_cycle_set_hash
    AND r.family_matrix_revision = c.family_matrix_revision
  ), false) AS ready,
  c.invalidated_at,
  c.invalidation_reason,
  c.updated_at,
  r.dependency_envelope
FROM public.makesafe_readiness_current c
LEFT JOIN public.makesafe_readiness_revisions r
  ON r.job_id = c.job_id
 AND r.readiness_revision = c.readiness_revision;

CREATE OR REPLACE VIEW public.makesafe_revision_approvals_current_v2
WITH (security_invoker = true)
AS
SELECT a.*
FROM public.makesafe_revision_approvals a
JOIN public.makesafe_readiness_current_v2 c
  ON c.job_id = a.job_id
 AND c.readiness_revision = a.readiness_revision
 AND c.dependency_generation = a.dependency_generation
WHERE a.decision = 'approved'
  AND c.ready = true;

CREATE OR REPLACE VIEW public.makesafe_cancellation_current_v2
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (d.job_id)
  d.*
FROM public.makesafe_cancellation_decisions d
JOIN public.makesafe_readiness_current c
  ON c.job_id = d.job_id
 AND c.attendance_cycle_set_hash = d.attendance_cycle_set_hash
ORDER BY d.job_id, d.decided_at DESC, d.id DESC;

CREATE OR REPLACE VIEW public.makesafe_terminal_proofs_current_v2
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (p.job_id)
  p.*
FROM public.makesafe_terminal_proofs p
JOIN public.makesafe_readiness_current c
  ON c.job_id = p.job_id
 AND c.attendance_cycle_set_hash = p.attendance_cycle_set_hash
WHERE (
    p.readiness_revision IS NULL
    OR p.readiness_revision = c.readiness_revision
  )
  AND p.attendance_cycle_set_hash =
    public.makesafe_attendance_cycle_set_hash_v1(p.attendance_cycle_ids)
ORDER BY p.job_id, p.proven_at DESC, p.id DESC;

CREATE OR REPLACE VIEW public.makesafe_family_rules_current_v2
WITH (security_invoker = true)
AS
SELECT r.*
FROM public.makesafe_family_rule_current c
JOIN public.makesafe_family_rule_revisions r
  ON r.id = c.revision_id
 AND r.family_code = c.family_code;

-- Every Phase-1 relation is service-role-only. Compare mode is also guarded in
-- ops-api, so an authenticated client cannot bypass the privileged envelope.
DO $$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'makesafe_state_projection_config',
    'makesafe_family_rule_revisions',
    'makesafe_family_rule_current',
    'makesafe_portal_capture_revisions',
    'makesafe_readiness_revisions',
    'makesafe_readiness_current',
    'makesafe_readiness_invalidations',
    'makesafe_revision_approvals',
    'makesafe_cancellation_decisions',
    'makesafe_terminal_proofs'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      relation_name
    );
    EXECUTE format(
      'REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',
      relation_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON public.%I TO service_role',
      relation_name
    );
  END LOOP;
END;
$$;
GRANT UPDATE ON public.makesafe_readiness_current TO service_role;
GRANT UPDATE ON public.makesafe_state_projection_config TO service_role;
GRANT UPDATE ON public.makesafe_family_rule_current TO service_role;

REVOKE ALL ON public.makesafe_readiness_current_v2
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.makesafe_revision_approvals_current_v2
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.makesafe_cancellation_current_v2
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.makesafe_terminal_proofs_current_v2
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.makesafe_family_rules_current_v2
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.makesafe_readiness_current_v2 TO service_role;
GRANT SELECT ON public.makesafe_revision_approvals_current_v2 TO service_role;
GRANT SELECT ON public.makesafe_cancellation_current_v2 TO service_role;
GRANT SELECT ON public.makesafe_terminal_proofs_current_v2 TO service_role;
GRANT SELECT ON public.makesafe_family_rules_current_v2 TO service_role;

REVOKE ALL ON FUNCTION public.reject_makesafe_state_audit_mutation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.makesafe_canonical_json_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.makesafe_readiness_revision_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.makesafe_attendance_cycle_set_hash_v1(uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_makesafe_readiness(
  uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_makesafe_readiness(
  uuid, bigint, text, text, text, jsonb, boolean, jsonb, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_makesafe_fact_dependency()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_makesafe_case_dependency()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_makesafe_authority_dependency()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_makesafe_family_pointer()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_makesafe_readiness(
  uuid, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.makesafe_canonical_json_v1(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.makesafe_readiness_revision_v1(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_makesafe_readiness(
  uuid, bigint, text, text, text, jsonb, boolean, jsonb, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.makesafe_attendance_cycle_set_hash_v1(uuid[])
  TO service_role;

COMMENT ON TABLE public.makesafe_readiness_revisions IS
  'Immutable makesafe-state.v2 readiness revisions. Phase 1 compare-only; never a v1 stage source.';
COMMENT ON TABLE public.makesafe_readiness_current IS
  'One guarded readiness pointer/generation per make-safe job. Material facts atomically invalidate this row.';
COMMENT ON TABLE public.makesafe_cancellation_decisions IS
  'Append-only cancellation decisions. Cancellation is a typed overlay, never a seventh v2 stage.';
COMMENT ON TABLE public.makesafe_terminal_proofs IS
  'Immutable exact-attendance-cycle-set terminal proof. Sparse historical status is not proof.';
