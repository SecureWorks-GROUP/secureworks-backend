-- One on-site client sign-off per capture, even when two copies arrive at once.
--
-- Before: ops-api checked for a matching stored sign-off, then wrote the
-- signature image (job_media) and the sign-off row as two separate inserts.
-- Two identical requests at the same moment (a double tap, or a retry after a
-- lost response) could both see nothing and both write, leaving two sign-off
-- rows and two signature images.
--
-- Now: record_on_site_client_signoff writes both in one transaction, keyed on
-- the existing job_client_signoffs.capture_request_id (unique index
-- job_client_signoffs_capture_request_key, 20261106054912). ops-api sends the
-- key: from the app's capture id, or worked out from the group, the person
-- capturing, the signature image and the answers. The function takes a
-- transaction lock on that key, returns the stored row when the key is
-- already used, and only otherwise writes the signature image and the
-- sign-off row. The sign-off insert also does nothing on a key conflict, so
-- the unique index stays the last word. A losing request writes nothing.
--
-- The sign-off row cannot be written first and pointed at its image later:
-- job_client_signoffs is append-only and an on-site row must name its image
-- when it is inserted.
--
-- No existing row changes and no new index is created, so existing rows
-- cannot violate anything here. Office copies already use the same key column
-- with random ids; on-site keys are hashed into it and never chosen by a
-- caller. Nothing here sends, writes money or touches shares. The runner
-- supplies the transaction.

CREATE OR REPLACE FUNCTION public.record_on_site_client_signoff(
  p_capture_request_id uuid,
  p_capture_payload_hash text,
  p_org_id uuid,
  p_job_id uuid,
  p_signed_name text,
  p_happy boolean,
  p_satisfaction_rating smallint,
  p_signature_png text,
  p_captured_by uuid,
  p_captured_by_actor text,
  p_captured_device text,
  p_outstanding_items text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_hash text;
  v_media uuid;
BEGIN
  IF p_capture_request_id IS NULL
    OR coalesce(p_capture_payload_hash, '') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'on_site_signoff_key_required' USING ERRCODE = '22023';
  END IF;
  -- Two copies of one capture queue here; the second sees the first's row.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('job_client_signoffs.capture_request_id:' || p_capture_request_id::text, 0)
  );
  SELECT s.id, s.capture_payload_hash INTO v_id, v_hash
    FROM public.job_client_signoffs s
   WHERE s.capture_request_id = p_capture_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'signoff_id', v_id,
      'claimed', false,
      'same_capture', v_hash IS NOT DISTINCT FROM p_capture_payload_hash
    );
  END IF;
  INSERT INTO public.job_media (job_id, type, storage_url, label, phase, uploaded_by)
  VALUES (p_job_id, 'photo', p_signature_png, 'Client signature', 'signature', p_captured_by)
  RETURNING id INTO v_media;
  INSERT INTO public.job_client_signoffs (
    org_id, job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by, captured_by_actor, captured_device,
    outstanding_items, capture_request_id, capture_payload_hash
  ) VALUES (
    p_org_id, p_job_id, 'on_site', p_signed_name, p_happy, p_satisfaction_rating,
    v_media, p_captured_by, p_captured_by_actor, p_captured_device,
    p_outstanding_items, p_capture_request_id, p_capture_payload_hash
  )
  ON CONFLICT (capture_request_id) WHERE capture_request_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    -- Unreachable under the lock. Fail the whole call so the image rolls back.
    RAISE EXCEPTION 'on_site_signoff_claim_lost' USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_build_object('signoff_id', v_id, 'claimed', true, 'same_capture', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_on_site_client_signoff(uuid, text, uuid, uuid, text, boolean, smallint, text, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_on_site_client_signoff(uuid, text, uuid, uuid, text, boolean, smallint, text, uuid, text, text, text)
  TO service_role;

COMMENT ON FUNCTION public.record_on_site_client_signoff(uuid, text, uuid, uuid, text, boolean, smallint, text, uuid, text, text, text) IS
  'Writes one on-site client sign-off and its signature image together, once per capture_request_id. A repeat of the key returns the stored row and writes nothing (claimed false; same_capture says whether the answers match).';
