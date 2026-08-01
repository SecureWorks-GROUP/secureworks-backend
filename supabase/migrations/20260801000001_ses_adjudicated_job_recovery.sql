-- Captain ruling 2026-08-01: narrow support for a historical SES job-card
-- recovery. Live deterministic work still uses the existing intake runtime.
-- This migration adds only an idempotent lineage-binding RPC and a uniqueness
-- guard for historical recovery keys; it creates no job and changes no status.

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_historical_backfill_key
  ON public.jobs ((metadata->>'historical_backfill_key'))
  WHERE btrim(COALESCE(metadata->>'historical_backfill_key', '')) <> '';

CREATE OR REPLACE FUNCTION public.bind_adjudicated_ses_existing_job(
  p_case_id uuid,
  p_source_post_ids text[],
  p_target_job_id uuid,
  p_expected_identity_key text,
  p_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_org constant uuid := '00000000-0000-0000-0000-000000000001';
  c_case constant uuid := '7d1c12cf-bc52-4a7a-8b38-74fc27057fc6';
  c_graph_source constant text :=
    'AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAXeAaSAAA=';
  c_mailbox_source constant text :=
    'mailbox_5a3ee1f82619e6ae5c11614751ef5301abd20ec91842e687e1a6cb72d1906061';
  v_requested_sources text[];
  v_actual_sources text[];
  v_existing_count integer;
  v_inserted_count integer;
BEGIN
  IF p_case_id IS NULL OR p_target_job_id IS NULL THEN
    RAISE EXCEPTION 'case and target job are required';
  END IF;
  IF p_case_id <> c_case THEN
    RAISE EXCEPTION 'captain ruling authorizes only the BWCWA-6648 source case';
  END IF;
  IF p_source_post_ids IS NULL
     OR cardinality(p_source_post_ids) < 1
     OR cardinality(p_source_post_ids) > 10 THEN
    RAISE EXCEPTION 'between 1 and 10 exact source post ids are required';
  END IF;
  IF btrim(COALESCE(p_expected_identity_key, '')) = '' THEN
    RAISE EXCEPTION 'expected identity key is required';
  END IF;
  IF p_expected_identity_key <> 'ref:BWCWA-6648' THEN
    RAISE EXCEPTION 'captain ruling authorizes only ref:BWCWA-6648';
  END IF;
  IF jsonb_typeof(p_evidence) <> 'object'
     OR p_evidence->>'captain_ruling_date' IS DISTINCT FROM '2026-08-01'
     OR p_evidence->>'adjudication_ref' IS DISTINCT FROM
       'data/ses-shadow-adjudicate-v1/report.md#6.1'
     OR p_evidence->>'legacy_incomplete_evidence' IS DISTINCT FROM 'true'
     OR p_evidence->>'side_effects_suppressed' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'captain ruling, adjudication, and suppression evidence are required';
  END IF;

  SELECT array_agg(requested.post_id ORDER BY requested.post_id)
  INTO v_requested_sources
  FROM (
    SELECT DISTINCT btrim(input_source.post_id) AS post_id
    FROM unnest(p_source_post_ids) AS input_source(post_id)
    WHERE btrim(COALESCE(input_source.post_id, '')) <> ''
  ) requested;
  IF cardinality(v_requested_sources) <> cardinality(p_source_post_ids) THEN
    RAISE EXCEPTION 'source post ids must be non-empty and distinct';
  END IF;
  IF cardinality(v_requested_sources) <> 2
     OR NOT v_requested_sources @> ARRAY[c_graph_source, c_mailbox_source]
     OR NOT ARRAY[c_graph_source, c_mailbox_source] @> v_requested_sources THEN
    RAISE EXCEPTION 'captain ruling authorizes only the exact BWCWA-6648 source transports';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.jobs job
    WHERE job.org_id = c_org
      AND job.id = p_target_job_id
      AND job.type = 'makesafe'
      AND job.metadata->>'historical_backfill_key' =
        'ses-historical:BWCWA-6648:INV-0754'
      AND job.metadata->>'legacy_incomplete_evidence' = 'true'
      AND job.metadata->>'historical_invoice_number' = 'INV-0754'
      AND job.metadata->>'external_ref' = 'BWCWA-6648'
      AND job.metadata->'requesting_company'->>'slug' = 'bw'
  ) THEN
    RAISE EXCEPTION 'target must be the exact same-org historical make-safe job';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.makesafe_intake_cases intake_case
    WHERE intake_case.org_id = c_org
      AND intake_case.id = p_case_id
      AND intake_case.job_id IS NULL
      AND intake_case.state = 'exception'
      AND intake_case.external_ref_canonical = 'BWCWA-6648'
  ) THEN
    RAISE EXCEPTION 'source case must retain a prior no-job terminal fate';
  END IF;

  SELECT array_agg(source.post_id ORDER BY source.post_id)
  INTO v_actual_sources
  FROM public.makesafe_intake_case_sources source
  WHERE source.org_id = c_org
    AND source.case_id = p_case_id;
  IF v_actual_sources IS DISTINCT FROM v_requested_sources THEN
    RAISE EXCEPTION 'source list must equal the complete persisted case lineage';
  END IF;

  SELECT count(*)
  INTO v_existing_count
  FROM public.makesafe_intake_source_authority_corrections correction
  WHERE correction.org_id = c_org
    AND correction.source_post_id = ANY(v_requested_sources);

  IF v_existing_count = cardinality(v_requested_sources) THEN
    IF EXISTS (
      SELECT 1
      FROM public.makesafe_intake_source_authority_corrections correction
      WHERE correction.org_id = c_org
        AND correction.source_post_id = ANY(v_requested_sources)
        AND (
          correction.correction_kind <> 'existing_job_binding'
          OR correction.target_job_id IS DISTINCT FROM p_target_job_id
          OR correction.expected_identity_key IS DISTINCT FROM p_expected_identity_key
          OR correction.evidence->>'captain_ruling_date' IS DISTINCT FROM '2026-08-01'
          OR correction.evidence->>'adjudication_ref' IS DISTINCT FROM
            'data/ses-shadow-adjudicate-v1/report.md#6.1'
        )
    ) THEN
      RAISE EXCEPTION 'existing source authority correction conflicts with recovery';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'already_bound',
      'bound_count', v_existing_count,
      'target_job_id', p_target_job_id
    );
  ELSIF v_existing_count <> 0 THEN
    RAISE EXCEPTION 'partial source authority correction set refused';
  END IF;

  INSERT INTO public.makesafe_intake_source_authority_corrections (
    org_id,
    source_post_id,
    target_job_id,
    correction_kind,
    expected_identity_key,
    evidence
  )
  SELECT
    c_org,
    input_source.post_id,
    p_target_job_id,
    'existing_job_binding',
    p_expected_identity_key,
    p_evidence || jsonb_build_object(
      'legacy_case_id', p_case_id,
      'source_post_id', input_source.post_id
    )
  FROM unnest(v_requested_sources) AS input_source(post_id);
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  IF v_inserted_count <> cardinality(v_requested_sources) THEN
    RAISE EXCEPTION 'lineage binding insert count drifted';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'bound',
    'bound_count', v_inserted_count,
    'target_job_id', p_target_job_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bind_adjudicated_ses_existing_job(
  uuid, text[], uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_adjudicated_ses_existing_job(
  uuid, text[], uuid, text, jsonb
) TO service_role;

COMMENT ON FUNCTION public.bind_adjudicated_ses_existing_job(
  uuid, text[], uuid, text, jsonb
) IS
  'Idempotently binds one complete prior no-job SES source lineage to one already-created, captain-accepted historical make-safe job. It creates no job, invoice, status, or communication.';
