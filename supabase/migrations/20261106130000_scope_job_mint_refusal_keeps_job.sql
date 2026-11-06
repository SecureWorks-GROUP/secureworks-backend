-- A refused mint leaves the existing job exactly as it was.
--
-- Fault (second-model review of 20261106081500, 6 Nov 2026): in
-- bind_fence_job_mint_identity the new settlement helper runs AFTER the job
-- write. Case: a job names opportunity P but has no contact, and the completed
-- mint holding P names contact B. A new request for contact A supplies P. Bind
-- writes contact A onto the job, the helper then sees the holder's different
-- contact and answers opportunity_mapping_conflict, and a plain RETURN keeps
-- the job write. The operator is told the request was refused while the job
-- now carries the other customer's contact. The open-job branch had the same
-- shape: it wrote a held opportunity onto the job and then refused. Before
-- 20261106081500 the later ledger write raised unique_violation, and the
-- handler rolled the job write back.
--
-- Fix: a settlement refusal is raised and caught by the function's own
-- handler, so the whole call is rolled back (the job write and the identity
-- lock), exactly as the unique_violation refusal was before. The refusal the
-- caller sees is unchanged. Reuse of a customer's open job, joining an
-- in-flight holder and every other answer are unchanged.
--
-- The body is the live 20261106081500 body with only that change. No job,
-- mint or GHL row is written by applying this migration.

CREATE OR REPLACE FUNCTION public.bind_fence_job_mint_identity(
  p_request_id uuid,
  p_contact_id text,
  p_opportunity_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request record;
  v_contact_key text := 'ghl:' || lower(regexp_replace(COALESCE(p_contact_id, ''), '[^a-zA-Z0-9]+', '', 'g'));
  v_lock record;
  v_other record;
  v_job record;
  v_jobs uuid[];
  v_added uuid[];
  v_candidate_count integer;
  v_settled jsonb;
BEGIN
  SELECT request_id, org_id, requested_by, type, intent, identity_key, input_fingerprint,
    state, owner_request_id, contact_id, opportunity_id, job_id,
    expected_existing_job_ids, repeat_reason, first_name, last_name,
    client_email, client_phone, site_address, site_suburb, mapping_outcome,
    last_error_code, last_error_message, created_at, updated_at
  INTO v_request FROM public.fence_job_mint_requests WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('decision', 'conflict', 'code', 'mint_request_not_found', 'message', 'Mint request was not found'); END IF;
  IF v_request.owner_request_id IS NOT NULL THEN RETURN public._fence_mint_progress(v_request.request_id, true); END IF;
  IF v_request.state = 'complete' THEN RETURN public._fence_mint_progress(v_request.request_id, false); END IF;
  IF p_contact_id IS NULL OR trim(p_contact_id) = '' THEN RETURN jsonb_build_object('decision', 'conflict', 'code', 'contact_identity_required', 'message', 'Verified contact identity is required'); END IF;
  IF v_request.contact_id IS NOT NULL AND v_request.contact_id <> p_contact_id THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'contact_mapping_conflict', 'message', 'Mint request already carries a different contact mapping');
  END IF;
  IF v_request.opportunity_id IS NOT NULL AND p_opportunity_id IS NOT NULL AND v_request.opportunity_id <> p_opportunity_id THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_mapping_conflict', 'message', 'Mint request already carries a different opportunity mapping');
  END IF;

  -- Converge callers that began with email/phone and callers that already knew
  -- the same GHL contact onto one contact/type serialization row.
  INSERT INTO public.fence_job_mint_locks (org_id, type, identity_key)
  VALUES (v_request.org_id, v_request.type, v_contact_key)
  ON CONFLICT (org_id, type, identity_key) DO NOTHING;
  SELECT org_id, type, identity_key, owner_request_id, updated_at
  INTO v_lock FROM public.fence_job_mint_locks
    WHERE org_id = v_request.org_id AND type = v_request.type AND identity_key = v_contact_key
    FOR UPDATE;
  IF v_lock.owner_request_id IS NOT NULL AND v_lock.owner_request_id <> v_request.request_id THEN
    SELECT request_id, org_id, state, owner_request_id, contact_id, opportunity_id, job_id, mapping_outcome
    INTO v_other FROM public.fence_job_mint_requests WHERE request_id = v_lock.owner_request_id;
    IF v_other.state IN ('reserved', 'contact_resolved', 'opportunity_created') THEN
      UPDATE public.fence_job_mint_requests SET state = 'joined', owner_request_id = v_other.request_id,
        contact_id = p_contact_id, opportunity_id = COALESCE(p_opportunity_id, opportunity_id), updated_at = now()
      WHERE request_id = v_request.request_id;
      RETURN public._fence_mint_progress(v_request.request_id, true);
    END IF;
  END IF;
  UPDATE public.fence_job_mint_locks SET owner_request_id = v_request.request_id, updated_at = now()
    WHERE org_id = v_request.org_id AND type = v_request.type AND identity_key = v_contact_key;

  IF p_opportunity_id IS NOT NULL THEN
    SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
    INTO v_job FROM public.jobs
      WHERE org_id = v_request.org_id AND type = v_request.type AND ghl_opportunity_id = p_opportunity_id
      LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF v_job.ghl_contact_id IS NOT NULL AND v_job.ghl_contact_id <> p_contact_id THEN
        RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_contact_conflict', 'message', 'Opportunity is mapped to a job for a different contact');
      END IF;
      UPDATE public.jobs SET ghl_contact_id = COALESCE(ghl_contact_id, p_contact_id), updated_at = now() WHERE id = v_job.id
      RETURNING id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at INTO v_job;
      v_settled := public._fence_mint_settle_held_opportunity(v_request.request_id, p_contact_id, p_opportunity_id, v_job.id, 'existing_opportunity_reused');
      IF v_settled->>'decision' = 'conflict' THEN RAISE EXCEPTION USING ERRCODE = 'SWM01'; END IF;
      IF v_settled IS NOT NULL THEN RETURN v_settled; END IF;
      UPDATE public.fence_job_mint_requests SET state = 'opportunity_created', contact_id = p_contact_id,
        opportunity_id = p_opportunity_id, job_id = v_job.id, mapping_outcome = 'existing_opportunity_reused',
        completed_at = NULL, updated_at = now() WHERE request_id = v_request.request_id;
      RETURN public._fence_mint_progress(v_request.request_id, false);
    END IF;
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_jobs
  FROM public.jobs
  WHERE org_id = v_request.org_id AND type = v_request.type AND ghl_contact_id = p_contact_id
    AND status::text NOT IN ('complete', 'cancelled', 'invoiced', 'lost');

  -- DELIBERATE_REPEAT is governed by its expected-evidence check below, which is
  -- the stronger guard. Blocking it here would make repeat intent unreachable for
  -- any contact that already has two or more active fencing jobs.
  IF cardinality(v_jobs) > 1 AND v_request.intent <> 'DELIBERATE_REPEAT' THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'multiple_active_jobs', 'message', 'Contact maps to multiple active ' || v_request.type || ' jobs', 'jobIds', to_jsonb(v_jobs));
  END IF;

  IF cardinality(v_jobs) = 1 AND v_request.intent = 'RESOLVED_NO_JOB' THEN
    SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
    INTO v_job FROM public.jobs WHERE id = v_jobs[1] FOR UPDATE;
    IF p_opportunity_id IS NOT NULL AND v_job.ghl_opportunity_id IS NOT NULL AND v_job.ghl_opportunity_id <> p_opportunity_id THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'contact_opportunity_job_conflict', 'message', 'Contact and opportunity point to different job evidence');
    END IF;
    UPDATE public.jobs SET ghl_opportunity_id = COALESCE(ghl_opportunity_id, p_opportunity_id), updated_at = now() WHERE id = v_job.id
    RETURNING id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at INTO v_job;
    IF v_job.ghl_opportunity_id IS NOT NULL THEN
      -- The mint that made this job usually still holds its opportunity: join
      -- it rather than write the same opportunity onto a second owner row.
      v_settled := public._fence_mint_settle_held_opportunity(v_request.request_id, p_contact_id, v_job.ghl_opportunity_id, v_job.id, 'existing_contact_job_reused');
      IF v_settled->>'decision' = 'conflict' THEN RAISE EXCEPTION USING ERRCODE = 'SWM01'; END IF;
      IF v_settled IS NOT NULL THEN RETURN v_settled; END IF;
      UPDATE public.fence_job_mint_requests SET state = 'opportunity_created', contact_id = p_contact_id,
        opportunity_id = v_job.ghl_opportunity_id, job_id = v_job.id, mapping_outcome = 'existing_contact_job_reused',
        completed_at = NULL, updated_at = now() WHERE request_id = v_request.request_id;
      RETURN public._fence_mint_progress(v_request.request_id, false);
    END IF;
    -- Keep the existing job candidate on the ledger while the command creates
    -- and records its missing opportunity. The complete RPC binds that mapping.
    -- Returning here keeps this the only outcome of the branch: no later guard
    -- may leave the ledger carrying a job_id behind a conflict decision, and a
    -- resolved existing job is by definition not a historically ambiguous one.
    UPDATE public.fence_job_mint_requests SET state = 'contact_resolved', contact_id = p_contact_id,
      job_id = v_job.id, mapping_outcome = 'existing_contact_job_reused', completed_at = NULL,
      updated_at = now() WHERE request_id = v_request.request_id;
    RETURN public._fence_mint_progress(v_request.request_id, false);
  END IF;

  IF v_request.intent = 'DELIBERATE_REPEAT' AND v_jobs <> public._fence_mint_sorted_uuids(v_request.expected_existing_job_ids) THEN
    SELECT ARRAY(SELECT unnest(v_jobs) EXCEPT SELECT unnest(COALESCE(v_request.expected_existing_job_ids, '{}'))) INTO v_added;
    IF cardinality(v_added) = 1 AND EXISTS (
      SELECT 1 FROM public.fence_job_mint_requests m
      WHERE m.org_id = v_request.org_id AND m.contact_id = p_contact_id AND m.job_id = v_added[1] AND m.state = 'complete'
    ) THEN
      SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
      INTO v_job FROM public.jobs WHERE id = v_added[1];
      v_settled := public._fence_mint_settle_held_opportunity(v_request.request_id, p_contact_id, v_job.ghl_opportunity_id, v_job.id, 'concurrent_request_reused');
      IF v_settled->>'decision' = 'conflict' THEN RAISE EXCEPTION USING ERRCODE = 'SWM01'; END IF;
      IF v_settled IS NOT NULL THEN RETURN v_settled; END IF;
      UPDATE public.fence_job_mint_requests SET state = 'complete', contact_id = p_contact_id,
        opportunity_id = v_job.ghl_opportunity_id, job_id = v_job.id, mapping_outcome = 'concurrent_request_reused',
        completed_at = now(), updated_at = now() WHERE request_id = v_request.request_id;
      RETURN public._fence_mint_progress(v_request.request_id, true);
    END IF;
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'stale_existing_job_evidence', 'message', 'Existing-job evidence changed; refresh before creating another job', 'jobIds', to_jsonb(v_jobs));
  END IF;

  -- Historical rows without contact mapping are never treated as "none".
  SELECT count(*) INTO v_candidate_count FROM public.jobs
  WHERE org_id = v_request.org_id AND type = v_request.type AND ghl_contact_id IS NULL
    AND status::text NOT IN ('cancelled', 'lost')
    AND (
      (COALESCE(trim(v_request.client_email), '') <> '' AND lower(trim(client_email)) = lower(trim(v_request.client_email))) OR
      (COALESCE(regexp_replace(v_request.client_phone, '[^0-9]+', '', 'g'), '') <> '' AND regexp_replace(client_phone, '[^0-9]+', '', 'g') = regexp_replace(v_request.client_phone, '[^0-9]+', '', 'g')) OR
      (COALESCE(lower(trim(v_request.site_address)), '') <> '' AND lower(trim(site_address)) = lower(trim(v_request.site_address)))
    );
  IF v_candidate_count > 0 THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'ambiguous_historical_mapping', 'message', 'A historical ' || v_request.type || ' job matches this identity but has no verified GHL contact mapping', 'candidateCount', v_candidate_count);
  END IF;

  UPDATE public.fence_job_mint_requests SET state = 'contact_resolved', contact_id = p_contact_id,
    opportunity_id = COALESCE(p_opportunity_id, opportunity_id), updated_at = now()
  WHERE request_id = v_request.request_id;
  RETURN public._fence_mint_progress(v_request.request_id, false);
EXCEPTION
  -- A settlement refusal is raised, not returned, so every write this call
  -- made (the job's contact or opportunity, the identity lock) is rolled
  -- back with it. v_settled keeps its value: PL/pgSQL variables are not
  -- rolled back.
  WHEN SQLSTATE 'SWM01' THEN
    RETURN v_settled;
  WHEN unique_violation THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_mapping_conflict', 'message', 'Opportunity is reserved by another mint request');
END;
$$;

REVOKE ALL ON FUNCTION public.bind_fence_job_mint_identity(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_fence_job_mint_identity(uuid, text, text) TO service_role;
