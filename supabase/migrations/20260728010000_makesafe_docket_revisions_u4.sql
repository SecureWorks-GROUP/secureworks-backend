-- SES Reporting U4: append-only, pre-Xero docket revisions.
-- This migration creates draft facts only. It does not schedule the assembler,
-- mutate a job/board row, create an invoice, send a communication, or close work.

CREATE TABLE IF NOT EXISTS public.makesafe_docket_revisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  source_instruction_id text NOT NULL CHECK (length(btrim(source_instruction_id)) > 0),
  lineage_id text NOT NULL CHECK (length(btrim(lineage_id)) > 0),
  attendance_cycle_ids uuid[] NOT NULL
    CHECK (cardinality(attendance_cycle_ids) > 0),
  current_attendance_cycle_id uuid NOT NULL
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE RESTRICT,
  readiness_revision text
    CHECK (
      readiness_revision IS NULL
      OR readiness_revision ~ '^sha256:[0-9a-f]{64}$'
    ),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  assembler_version text NOT NULL CHECK (length(btrim(assembler_version)) > 0),
  family_matrix_version text NOT NULL
    CHECK (length(btrim(family_matrix_version)) > 0),
  input_content_hash text NOT NULL
    CHECK (input_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  output_content_hash text NOT NULL
    CHECK (output_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('ready', 'blocked')),
  pre_xero_docs_ready boolean NOT NULL,
  local_invoice_proposal jsonb
    CHECK (
      local_invoice_proposal IS NULL
      OR jsonb_typeof(local_invoice_proposal) = 'object'
    ),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(blockers) = 'array'),
  email_drafts jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(email_drafts) = 'object'),
  review_spec jsonb NOT NULL CHECK (jsonb_typeof(review_spec) = 'object'),
  release_payload jsonb NOT NULL CHECK (jsonb_typeof(release_payload) = 'object'),
  superseded_revision_id uuid
    REFERENCES public.makesafe_docket_revisions(id) ON DELETE RESTRICT,
  retention_class text NOT NULL DEFAULT 'operations-record'
    CHECK (retention_class IN ('operations-record', 'blocked-diagnostic')),
  artifact_count integer NOT NULL CHECK (artifact_count >= 0),
  artifact_size_bytes bigint NOT NULL CHECK (artifact_size_bytes >= 0),
  accepted_at timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stage_durations_ms jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(stage_durations_ms) = 'object'),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  CONSTRAINT makesafe_docket_revisions_current_cycle_member CHECK (
    current_attendance_cycle_id = ANY (attendance_cycle_ids)
  ),
  CONSTRAINT makesafe_docket_revisions_ready_shape CHECK (
    (state = 'ready' AND pre_xero_docs_ready)
    OR (state = 'blocked' AND NOT pre_xero_docs_ready)
  ),
  CONSTRAINT makesafe_docket_revisions_draft_wall CHECK (
    COALESCE((envelope->>'invoice_create_approved')::boolean, false) = false
    AND COALESCE((envelope->>'client_send_approved')::boolean, false) = false
    AND COALESCE((release_payload->>'invoice_create_approved')::boolean, false) = false
    AND COALESCE((release_payload->>'client_send_approved')::boolean, false) = false
    AND COALESCE((release_payload->>'create_invoice')::boolean, false) = false
    AND COALESCE((release_payload->>'authorise_invoice')::boolean, false) = false
    AND COALESCE((release_payload->>'send_email')::boolean, false) = false
    AND COALESCE((release_payload->>'send_sms')::boolean, false) = false
    AND COALESCE((release_payload->>'close_job')::boolean, false) = false
    AND NOT (COALESCE(local_invoice_proposal, '{}'::jsonb) ? 'xero_invoice_id')
  ),
  UNIQUE (
    job_id,
    idempotency_key,
    assembler_version,
    family_matrix_version
  )
);

CREATE INDEX IF NOT EXISTS idx_makesafe_docket_revisions_job_committed
  ON public.makesafe_docket_revisions (job_id, committed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_makesafe_docket_revisions_input_hash
  ON public.makesafe_docket_revisions (job_id, input_content_hash);
CREATE INDEX IF NOT EXISTS idx_makesafe_docket_revisions_state
  ON public.makesafe_docket_revisions (state, committed_at DESC);

CREATE TABLE IF NOT EXISTS public.makesafe_docket_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  revision_id uuid NOT NULL
    REFERENCES public.makesafe_docket_revisions(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (length(btrim(role)) > 0),
  object_key text NOT NULL
    CHECK (
      length(btrim(object_key)) > 0
      AND object_key NOT LIKE '/%'
      AND object_key NOT LIKE '%..%'
    ),
  media_type text NOT NULL CHECK (length(btrim(media_type)) > 0),
  content_hash text NOT NULL
    CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  UNIQUE (revision_id, object_key)
);

CREATE INDEX IF NOT EXISTS idx_makesafe_docket_artifacts_job_revision
  ON public.makesafe_docket_artifacts (job_id, revision_id);

CREATE OR REPLACE FUNCTION public.reject_makesafe_docket_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_makesafe_docket_revisions_append_only
  ON public.makesafe_docket_revisions;
CREATE TRIGGER trg_makesafe_docket_revisions_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_docket_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_docket_append_only_change();

DROP TRIGGER IF EXISTS trg_makesafe_docket_artifacts_append_only
  ON public.makesafe_docket_artifacts;
CREATE TRIGGER trg_makesafe_docket_artifacts_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_docket_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_docket_append_only_change();

CREATE OR REPLACE VIEW public.makesafe_docket_revisions_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (revision.job_id)
  revision.*
FROM public.makesafe_docket_revisions revision
ORDER BY revision.job_id, revision.committed_at DESC, revision.id DESC;

CREATE OR REPLACE FUNCTION public.commit_makesafe_docket_revision_v1(
  p_revision jsonb,
  p_artifacts jsonb
)
RETURNS public.makesafe_docket_revisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  revision_id uuid := (p_revision->>'id')::uuid;
  target_job_id uuid := (p_revision->>'job_id')::uuid;
  target_org_id uuid := (p_revision->>'org_id')::uuid;
  target_idempotency_key text := btrim(p_revision->>'idempotency_key');
  target_assembler_version text := btrim(p_revision->>'assembler_version');
  target_matrix_version text := btrim(p_revision->>'family_matrix_version');
  existing public.makesafe_docket_revisions%ROWTYPE;
  prior_revision_id uuid;
  artifact jsonb;
  declared_count integer;
  declared_bytes bigint;
BEGIN
  IF jsonb_typeof(p_revision) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_artifacts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'revision object and artifacts array are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(target_job_id::text || ':' || target_idempotency_key, 0)
  );

  SELECT *
  INTO existing
  FROM public.makesafe_docket_revisions
  WHERE job_id = target_job_id
    AND idempotency_key = target_idempotency_key
    AND assembler_version = target_assembler_version
    AND family_matrix_version = target_matrix_version;

  IF FOUND THEN
    IF existing.id = revision_id
       AND existing.input_content_hash = p_revision->>'input_content_hash'
       AND existing.output_content_hash = p_revision->>'output_content_hash' THEN
      RETURN existing;
    END IF;
    RAISE EXCEPTION 'input_hash_conflict: idempotency key resolves to different docket content'
      USING ERRCODE = '23505';
  END IF;

  declared_count := jsonb_array_length(p_artifacts);
  SELECT COALESCE(sum((value->>'size_bytes')::bigint), 0)
  INTO declared_bytes
  FROM jsonb_array_elements(p_artifacts);

  SELECT current_revision.id
  INTO prior_revision_id
  FROM public.makesafe_docket_revisions_current current_revision
  WHERE current_revision.job_id = target_job_id;

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
    stage_durations_ms,
    created_by
  ) VALUES (
    revision_id,
    target_org_id,
    target_job_id,
    p_revision->>'source_instruction_id',
    p_revision->>'lineage_id',
    ARRAY(
      SELECT jsonb_array_elements_text(p_revision->'attendance_cycle_ids')::uuid
      ORDER BY 1
    ),
    (p_revision->>'current_attendance_cycle_id')::uuid,
    NULLIF(p_revision->>'readiness_revision', ''),
    target_idempotency_key,
    target_assembler_version,
    target_matrix_version,
    p_revision->>'input_content_hash',
    p_revision->>'output_content_hash',
    p_revision->>'state',
    (p_revision->>'pre_xero_docs_ready')::boolean,
    NULLIF(p_revision->'local_invoice_proposal', 'null'::jsonb),
    p_revision->'envelope',
    COALESCE(p_revision->'blockers', '[]'::jsonb),
    COALESCE(p_revision->'email_drafts', '{}'::jsonb),
    p_revision->'review_spec',
    p_revision->'release_payload',
    prior_revision_id,
    CASE
      WHEN p_revision->>'state' = 'blocked' THEN 'blocked-diagnostic'
      ELSE 'operations-record'
    END,
    declared_count,
    declared_bytes,
    (p_revision->>'accepted_at')::timestamptz,
    COALESCE(p_revision->'stage_durations_ms', '{}'::jsonb),
    COALESCE(NULLIF(btrim(p_revision->>'created_by'), ''), 'ses-u4-assembler')
  );

  FOR artifact IN
    SELECT value
    FROM jsonb_array_elements(p_artifacts)
    ORDER BY value->>'object_key'
  LOOP
    IF artifact->>'object_key' NOT LIKE
       'makesafe-docket-artifacts/' || target_job_id::text || '/' ||
       revision_id::text || '/%' THEN
      RAISE EXCEPTION 'artifact object_key is outside the docket revision prefix'
        USING ERRCODE = '22023';
    END IF;
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
      target_org_id,
      revision_id,
      target_job_id,
      artifact->>'role',
      artifact->>'object_key',
      artifact->>'media_type',
      artifact->>'content_hash',
      (artifact->>'size_bytes')::bigint,
      COALESCE(artifact->'metadata', '{}'::jsonb),
      COALESCE(NULLIF(btrim(p_revision->>'created_by'), ''), 'ses-u4-assembler')
    );
  END LOOP;

  SELECT *
  INTO existing
  FROM public.makesafe_docket_revisions
  WHERE id = revision_id;
  RETURN existing;
END;
$$;

ALTER TABLE public.makesafe_docket_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.makesafe_docket_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS makesafe_docket_revisions_service_role_only
  ON public.makesafe_docket_revisions;
CREATE POLICY makesafe_docket_revisions_service_role_only
  ON public.makesafe_docket_revisions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS makesafe_docket_artifacts_service_role_only
  ON public.makesafe_docket_artifacts;
CREATE POLICY makesafe_docket_artifacts_service_role_only
  ON public.makesafe_docket_artifacts
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.makesafe_docket_revisions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.makesafe_docket_artifacts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.makesafe_docket_revisions_current FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_makesafe_docket_revision_v1(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.makesafe_docket_revisions TO service_role;
GRANT SELECT, INSERT ON public.makesafe_docket_artifacts TO service_role;
GRANT SELECT ON public.makesafe_docket_revisions_current TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_makesafe_docket_revision_v1(jsonb, jsonb)
  TO service_role;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) VALUES (
  'makesafe-docket-artifacts',
  'makesafe-docket-artifacts',
  false,
  52428800,
  ARRAY[
    'application/json',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'text/html',
    'text/markdown',
    'text/plain'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

COMMENT ON TABLE public.makesafe_docket_revisions IS
  'U4 append-only pre-Xero docket revisions. Contains draft facts only; no invoice, send, board, or closeout authority.';
COMMENT ON TABLE public.makesafe_docket_artifacts IS
  'Content-addressed metadata for private artifacts under the makesafe-docket-artifacts bucket.';
COMMENT ON FUNCTION public.commit_makesafe_docket_revision_v1(jsonb, jsonb) IS
  'Atomically commits one ready-or-blocked U4 draft revision and its artifact metadata with idempotency/hash conflict protection.';
