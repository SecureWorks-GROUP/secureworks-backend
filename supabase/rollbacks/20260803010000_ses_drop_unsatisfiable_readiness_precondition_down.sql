-- ROLLBACK of 20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql
--
-- Restores the two function bodies EXACTLY as 20260728020000 defined them,
-- including the two `IF NOT FOUND OR NOT prior_readiness.current_ready THEN RAISE`
-- preconditions on `makesafe_readiness_current.ready`.
--
-- READ THIS BEFORE RUNNING IT. As of the captain's ruling on 2026-08-03 those
-- preconditions are UNSATISFIABLE: `makesafe_readiness_revisions` is empty in
-- production, both INNER JOINs below therefore find nothing for every job, and
-- restoring them re-blocks every invoice obligation on the board. Only run this
-- once a Phase-2 readiness producer can legitimately commit a READY readiness
-- revision without a caller asserting one.
--
-- The bodies below are byte-identical to lines 550-766 and 1318-1607 of
-- supabase/migrations/20260728020000_makesafe_ses_invoice_release_u5_u6.sql.

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

REVOKE ALL ON FUNCTION public.commit_ses_invoice_obligation_revision_v1(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ses_invoice_bound_docket_v1(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_ses_invoice_obligation_revision_v1(jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ses_invoice_bound_docket_v1(jsonb, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.commit_ses_invoice_obligation_revision_v1(jsonb, jsonb) IS NULL;
COMMENT ON FUNCTION public.commit_ses_invoice_bound_docket_v1(jsonb, jsonb) IS NULL;
