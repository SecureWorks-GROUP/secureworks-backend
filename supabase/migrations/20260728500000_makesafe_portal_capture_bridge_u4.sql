-- Persist the approved agent-side Prime capture as exact current-cycle evidence
-- that U4 can consume without pretending the Edge Function owns a browser.

ALTER TABLE public.makesafe_portal_capture_revisions
  ADD COLUMN IF NOT EXISTS capture_result text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_content_hash text,
  ADD COLUMN IF NOT EXISTS builder_reference text,
  ADD COLUMN IF NOT EXISTS captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS captured_by text,
  ADD COLUMN IF NOT EXISTS capture_producer text,
  ADD COLUMN IF NOT EXISTS capture_idempotency_key text,
  ADD COLUMN IF NOT EXISTS signal text,
  ADD COLUMN IF NOT EXISTS screenshot_object_key text,
  ADD COLUMN IF NOT EXISTS screenshot_media_type text,
  ADD COLUMN IF NOT EXISTS screenshot_content_hash text,
  ADD COLUMN IF NOT EXISTS screenshot_size_bytes bigint;

-- There was no producer for this ledger before this bridge. Refuse to silently
-- reinterpret any unexpected legacy row that lacks the new evidence contract.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_portal_capture_revisions
    WHERE capture_result IS NULL
       OR source_url IS NULL
       OR source_content_hash IS NULL
       OR builder_reference IS NULL
       OR captured_at IS NULL
       OR captured_by IS NULL
       OR capture_producer IS NULL
       OR capture_idempotency_key IS NULL
       OR signal IS NULL
  ) THEN
    RAISE EXCEPTION
      'makesafe_portal_capture_revisions contains pre-contract rows; review them before applying the U4 capture bridge';
  END IF;
END;
$$;

ALTER TABLE public.makesafe_portal_capture_revisions
  ALTER COLUMN capture_result SET NOT NULL,
  ALTER COLUMN source_url SET NOT NULL,
  ALTER COLUMN source_content_hash SET NOT NULL,
  ALTER COLUMN builder_reference SET NOT NULL,
  ALTER COLUMN captured_at SET NOT NULL,
  ALTER COLUMN captured_by SET NOT NULL,
  ALTER COLUMN capture_producer SET NOT NULL,
  ALTER COLUMN capture_idempotency_key SET NOT NULL,
  ALTER COLUMN signal SET NOT NULL;

ALTER TABLE public.makesafe_portal_capture_revisions
  DROP CONSTRAINT IF EXISTS makesafe_portal_capture_bridge_shape;
ALTER TABLE public.makesafe_portal_capture_revisions
  ADD CONSTRAINT makesafe_portal_capture_bridge_shape CHECK (
    role IN ('roof_report', 'assessment', 'photos', 'scope')
    AND capture_result IN ('done', 'not_done', 'unreachable')
    AND source_url ~ '^https://'
    AND source_content_hash ~ '^sha256:[0-9a-f]{64}$'
    AND length(btrim(captured_by)) > 0
    AND capture_producer = 'capture_portal_evidence.py/v1'
    AND length(btrim(capture_idempotency_key)) > 0
    AND length(btrim(signal)) > 0
    AND jsonb_array_length(evidence_refs) > 0
    AND (
      (capture_result = 'done' AND status = 'verified')
      OR (capture_result = 'not_done' AND status = 'captured')
      OR (capture_result = 'unreachable' AND status = 'rejected')
    )
    AND (
      (
        capture_result IN ('done', 'not_done')
        AND screenshot_object_key LIKE
          'makesafe-docket-artifacts/portal-captures/%'
        AND screenshot_media_type = 'image/png'
        AND screenshot_content_hash ~ '^sha256:[0-9a-f]{64}$'
        AND screenshot_size_bytes > 0
      )
      OR (
        capture_result = 'unreachable'
        AND screenshot_object_key IS NULL
        AND screenshot_media_type IS NULL
        AND screenshot_content_hash IS NULL
        AND screenshot_size_bytes IS NULL
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  uq_makesafe_portal_capture_idempotency
  ON public.makesafe_portal_capture_revisions (
    job_id,
    attendance_cycle_id,
    role,
    capture_idempotency_key
  );

COMMENT ON TABLE public.makesafe_portal_capture_revisions IS
  'Append-only current-cycle evidence from the approved capture_portal_evidence.py producer. U4 consumes exact job/cycle/role/URL rows and never launches a browser in the Edge Function.';
COMMENT ON COLUMN
  public.makesafe_portal_capture_revisions.source_content_hash IS
  'SHA-256 fingerprint of the rendered Prime content classified by the approved producer; distinct from the screenshot byte hash and the aggregate makesafe_content_hash.';
COMMENT ON COLUMN
  public.makesafe_portal_capture_revisions.screenshot_object_key IS
  'Private content-addressed PNG under makesafe-docket-artifacts/portal-captures. Required for done/not_done and absent for unreachable.';

CREATE OR REPLACE FUNCTION public.commit_makesafe_portal_capture_v1(
  p_capture jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job_id uuid;
  v_cycle_id uuid;
  v_current_cycle_id uuid;
  v_org_id uuid;
  v_role text;
  v_idempotency_key text;
  v_content_hash text;
  v_version bigint;
  v_existing public.makesafe_portal_capture_revisions%ROWTYPE;
  v_inserted public.makesafe_portal_capture_revisions%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_capture) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'p_capture must be an object';
  END IF;

  v_job_id := NULLIF(p_capture->>'job_id', '')::uuid;
  v_cycle_id := NULLIF(p_capture->>'attendance_cycle_id', '')::uuid;
  v_role := btrim(COALESCE(p_capture->>'role', ''));
  v_idempotency_key :=
    btrim(COALESCE(p_capture->>'capture_idempotency_key', ''));
  v_content_hash := btrim(COALESCE(
    p_capture->>'makesafe_content_hash',
    ''
  ));

  IF v_job_id IS NULL OR v_cycle_id IS NULL OR v_role = ''
     OR v_idempotency_key = ''
     OR v_content_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION
      'job_id, attendance_cycle_id, role, capture_idempotency_key and makesafe_content_hash are required';
  END IF;

  SELECT j.org_id, d.attendance_cycle_id
  INTO v_org_id, v_current_cycle_id
  FROM public.jobs j
  JOIN public.makesafe_job_details d ON d.job_id = j.id
  WHERE j.id = v_job_id
    AND j.type = 'makesafe'
  FOR SHARE OF j, d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'capture job is not a current make-safe card';
  END IF;
  IF v_current_cycle_id IS DISTINCT FROM v_cycle_id THEN
    RAISE EXCEPTION
      'capture attendance cycle % is not current cycle %',
      v_cycle_id,
      v_current_cycle_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_job_id::text || ':' || v_cycle_id::text || ':' || v_role,
    0
  ));

  SELECT *
  INTO v_existing
  FROM public.makesafe_portal_capture_revisions
  WHERE job_id = v_job_id
    AND attendance_cycle_id = v_cycle_id
    AND role = v_role
    AND capture_idempotency_key = v_idempotency_key;

  IF FOUND THEN
    IF v_existing.makesafe_content_hash IS DISTINCT FROM v_content_hash THEN
      RAISE EXCEPTION
        'portal capture idempotency conflict for %',
        v_idempotency_key
        USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(v_existing);
  END IF;

  SELECT COALESCE(MAX(makesafe_fact_version), 0) + 1
  INTO v_version
  FROM public.makesafe_portal_capture_revisions
  WHERE job_id = v_job_id
    AND attendance_cycle_id = v_cycle_id
    AND role = v_role;

  INSERT INTO public.makesafe_portal_capture_revisions (
    org_id,
    job_id,
    attendance_cycle_id,
    role,
    status,
    makesafe_fact_version,
    makesafe_content_hash,
    evidence_refs,
    created_by,
    capture_result,
    source_url,
    source_content_hash,
    builder_reference,
    captured_at,
    captured_by,
    capture_producer,
    capture_idempotency_key,
    signal,
    screenshot_object_key,
    screenshot_media_type,
    screenshot_content_hash,
    screenshot_size_bytes
  ) VALUES (
    v_org_id,
    v_job_id,
    v_cycle_id,
    v_role,
    p_capture->>'status',
    v_version,
    v_content_hash,
    COALESCE(p_capture->'evidence_refs', '[]'::jsonb),
    p_capture->>'created_by',
    p_capture->>'capture_result',
    p_capture->>'source_url',
    p_capture->>'source_content_hash',
    p_capture->>'builder_reference',
    (p_capture->>'captured_at')::timestamptz,
    p_capture->>'captured_by',
    p_capture->>'capture_producer',
    v_idempotency_key,
    p_capture->>'signal',
    NULLIF(p_capture->>'screenshot_object_key', ''),
    NULLIF(p_capture->>'screenshot_media_type', ''),
    NULLIF(p_capture->>'screenshot_content_hash', ''),
    NULLIF(p_capture->>'screenshot_size_bytes', '')::bigint
  )
  RETURNING * INTO v_inserted;

  RETURN to_jsonb(v_inserted);
END;
$$;

REVOKE ALL ON FUNCTION public.commit_makesafe_portal_capture_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_makesafe_portal_capture_v1(jsonb)
  TO service_role;
