-- SES invoice-bound docket: idempotent adopt on unique key collision.
--
-- Live failure (Bertram / INV-1102): a prior invoice_bound row already holds
-- idempotency_key = 'ses-invoice-bound:{obligation_revision_id}'. A later
-- pre_xero re-prepare made a new current base. Recovery tried to bind again
-- with a new content-addressed id but the same obligation-only key and hit
-- makesafe_docket_revisions_job_id_idempotency_key_assembler__key (23505).
--
-- Fix:
--   1. Scope the idempotency key to the pre_xero base:
--        ses-invoice-bound:{obligation}:{based_on_revision_id}
--      so a re-prepare can mint a new current invoice_bound with the same money.
--   2. Before insert, adopt any existing row with the same key (new or legacy
--      obligation-only) when the Xero identity matches (id, number, AUTHORISED,
--      total when present) and — for the legacy key — based_on matches.
--   3. On unique_violation, adopt the matching identity rather than fail closed.
--
-- Never mints a second Xero invoice. Never voids. Never sends.

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
  target_based_on uuid := (p_binding->>'based_on_revision_id')::uuid;
  target_xero jsonb := p_binding->'xero_binding';
  target_pdf_hash text := p_pdf_artifact->>'content_hash';
  prior_effect public.ses_external_effects%ROWTYPE;
  prior_readiness record;
  readiness_certified boolean;
  next_generation bigint;
  next_envelope jsonb;
  next_readiness_revision text;
  invalidation_reason text;
  legacy_idempotency_key text;
  target_idempotency_key text;
  target_invoice_id text := btrim(COALESCE(target_xero->>'xero_invoice_id', ''));
  target_invoice_number text := btrim(COALESCE(target_xero->>'invoice_number', ''));
  target_total numeric;
BEGIN
  IF jsonb_typeof(p_binding) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_pdf_artifact) IS DISTINCT FROM 'object'
     OR target_xero->>'status' IS DISTINCT FROM 'AUTHORISED'
     OR target_pdf_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_pdf_artifact->>'role' IS DISTINCT FROM 'xero_invoice_pdf'
     OR target_invoice_id = ''
     OR target_invoice_number = '' THEN
    RAISE EXCEPTION 'AUTHORISED Xero binding and real invoice PDF artifact are required'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    target_total := NULLIF(btrim(COALESCE(target_xero->>'total', '')), '')::numeric;
  EXCEPTION WHEN others THEN
    target_total := NULL;
  END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-invoice-docket:' || target_revision_id::text, 0)
  );

  -- Same content-addressed id → pure replay.
  SELECT * INTO inserted
  FROM public.makesafe_docket_revisions
  WHERE id = target_id;
  IF FOUND THEN
    IF inserted.stage = 'invoice_bound'
       AND inserted.invoice_obligation_revision_id = target_revision_id
       AND inserted.xero_binding->>'xero_invoice_id' = target_invoice_id
       AND btrim(COALESCE(inserted.xero_binding->>'invoice_number', '')) =
         target_invoice_number THEN
      RETURN inserted;
    END IF;
    RAISE EXCEPTION 'invoice-bound docket id resolves to different content'
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO base
  FROM public.makesafe_docket_revisions
  WHERE id = target_based_on
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

  legacy_idempotency_key := 'ses-invoice-bound:' || target_revision_id::text;
  target_idempotency_key :=
    'ses-invoice-bound:' || target_revision_id::text || ':' || base.id::text;

  -- Adopt exact new-format key (same base + obligation + assembler versions).
  SELECT * INTO inserted
  FROM public.makesafe_docket_revisions
  WHERE job_id = target_job_id
    AND idempotency_key = target_idempotency_key
    AND assembler_version = base.assembler_version
    AND family_matrix_version = base.family_matrix_version;
  IF FOUND THEN
    IF inserted.stage = 'invoice_bound'
       AND inserted.invoice_obligation_revision_id = target_revision_id
       AND inserted.xero_binding->>'xero_invoice_id' = target_invoice_id
       AND btrim(COALESCE(inserted.xero_binding->>'invoice_number', '')) =
         target_invoice_number
       AND (
         target_total IS NULL
         OR NULLIF(btrim(COALESCE(inserted.xero_binding->>'total', '')), '') IS NULL
         OR round(target_total * 100) =
           round((inserted.xero_binding->>'total')::numeric * 100)
       ) THEN
      RETURN inserted;
    END IF;
    RAISE EXCEPTION 'invoice-bound idempotency key resolves to different invoice identity'
      USING ERRCODE = '23505';
  END IF;

  -- Legacy obligation-only key: adopt only when based_on matches (true replay of
  -- the original bind). A different based_on falls through so a re-prepare can
  -- mint a new current bind under the based_on-scoped key.
  SELECT * INTO inserted
  FROM public.makesafe_docket_revisions
  WHERE job_id = target_job_id
    AND idempotency_key = legacy_idempotency_key
    AND assembler_version = base.assembler_version
    AND family_matrix_version = base.family_matrix_version;
  IF FOUND THEN
    IF inserted.stage = 'invoice_bound'
       AND inserted.invoice_obligation_revision_id = target_revision_id
       AND inserted.xero_binding->>'xero_invoice_id' = target_invoice_id
       AND btrim(COALESCE(inserted.xero_binding->>'invoice_number', '')) =
         target_invoice_number
       AND (
         target_total IS NULL
         OR NULLIF(btrim(COALESCE(inserted.xero_binding->>'total', '')), '') IS NULL
         OR round(target_total * 100) =
           round((inserted.xero_binding->>'total')::numeric * 100)
       )
       AND inserted.based_on_revision_id = base.id THEN
      RETURN inserted;
    END IF;
    IF NOT (
      inserted.stage = 'invoice_bound'
      AND inserted.invoice_obligation_revision_id = target_revision_id
      AND inserted.xero_binding->>'xero_invoice_id' = target_invoice_id
      AND btrim(COALESCE(inserted.xero_binding->>'invoice_number', '')) =
        target_invoice_number
    ) THEN
      RAISE EXCEPTION 'invoice-bound legacy idempotency key resolves to different invoice identity'
        USING ERRCODE = '23505';
    END IF;
    -- Same money, different base → fall through and insert with based_on key.
  END IF;

  SELECT * INTO prior_effect
  FROM public.ses_external_effects
  WHERE invoice_obligation_revision_id = target_revision_id
    AND effect_kind = 'invoice_authorise'
    AND state = 'confirmed'
    AND external_id = target_invoice_id;
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
  readiness_certified := FOUND AND COALESCE(prior_readiness.current_ready, false);

  BEGIN
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
      target_idempotency_key,
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
  EXCEPTION
    WHEN unique_violation THEN
      -- Race or leftover collision: adopt only the same INV identity.
      SELECT * INTO inserted
      FROM public.makesafe_docket_revisions
      WHERE job_id = target_job_id
        AND assembler_version = base.assembler_version
        AND family_matrix_version = base.family_matrix_version
        AND (
          idempotency_key = target_idempotency_key
          OR (
            idempotency_key = legacy_idempotency_key
            AND based_on_revision_id = base.id
          )
        )
        AND stage = 'invoice_bound'
        AND invoice_obligation_revision_id = target_revision_id
        AND xero_binding->>'xero_invoice_id' = target_invoice_id
        AND btrim(COALESCE(xero_binding->>'invoice_number', '')) =
          target_invoice_number
      ORDER BY committed_at DESC
      LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invoice-bound docket unique key collision without matching INV identity'
          USING ERRCODE = '23505';
      END IF;
      RETURN inserted;
  END;

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

  invalidation_reason := CASE
    WHEN readiness_certified
      THEN 'The real AUTHORISED Xero PDF created a new exact docket revision.'
    ELSE 'The real AUTHORISED Xero PDF created a new exact docket revision; '
      || 'readiness was NOT certified at bind (captain ruling 2026-08-03 dropped '
      || 'the unsatisfiable readiness precondition; no Phase-2 readiness producer exists).'
  END;
  next_generation := public.invalidate_makesafe_readiness(
    target_job_id,
    'makesafe_docket_revisions',
    inserted.id::text,
    invalidation_reason,
    inserted.created_by
  );

  IF readiness_certified THEN
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
  END IF;

  RETURN inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_ses_invoice_bound_docket_v1(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_ses_invoice_bound_docket_v1(jsonb, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.commit_ses_invoice_bound_docket_v1(jsonb, jsonb) IS
  'SES U6 invoice-bound docket commit. Idempotency key is '
  'ses-invoice-bound:{obligation}:{based_on} so a re-prepare can bind the same '
  'AUTHORISED invoice again. Legacy obligation-only keys are adopted only when '
  'based_on and INV identity match; unique_violation adopts matching INV identity.';
