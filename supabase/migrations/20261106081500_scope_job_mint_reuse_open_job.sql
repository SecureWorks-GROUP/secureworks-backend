-- A second start for a customer who already has an open job of that trade
-- reuses that job, as the RESOLVED_NO_JOB contract promises, instead of
-- refusing with opportunity_mapping_conflict.
--
-- Cause (Whole test 2, 6 Nov 2026): bind_fence_job_mint_identity resolves the
-- contact's one open job and then writes that job's opportunity onto the new
-- request's ledger row. The completed mint that made the job still holds that
-- opportunity in uq_fence_mint_request_opportunity, so the write raised
-- unique_violation and the catch-all answered "Opportunity is reserved by
-- another mint request". Every second start for the same customer and trade
-- by a new request id was refused, with nothing stale behind the reservation.
-- The same collision hit DELIBERATE_REPEAT's concurrent_request_reused branch
-- and the supplied-opportunity branch. The patio contract's reuse case passed
-- only because its checks compared NULL and so never raised.
--
-- Fix, in bind: before the request carries an opportunity another ledger row
-- holds, settle it explicitly.
--   * holder complete, same trade, contact and job: this request joins it and
--     returns that job (mapping outcome existing_contact_job_reused, or the
--     branch's own outcome). A retry with the same request id replays it.
--   * holder still in flight: this request joins it and waits, so two
--     genuinely concurrent mints still make exactly one job.
--   * holder for another trade, contact or job: a real conflict, as before.
--
-- Fix, in reserve: a request refused with nothing bound (no opportunity, no
-- job) may be judged again when the same request id is retried. A refusal is
-- a reading of the evidence at that moment, so a fix or a data repair must not
-- leave that request id refused forever. It rejoins the identity lock exactly
-- like a new request, so concurrency is unchanged, and its attempt count rises
-- so the edge reconciles any stamped opportunity before creating one.
--
-- Bodies are the live 20261028031500 bodies with only these changes. No job,
-- mint or GHL row is written by applying this migration.

-- Settle an opportunity that another ledger row already holds, before this
-- request writes it. Returns NULL when no other row holds it.
CREATE OR REPLACE FUNCTION public._fence_mint_settle_held_opportunity(
  p_request_id uuid,
  p_contact_id text,
  p_opportunity_id text,
  p_job_id uuid,
  p_outcome text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_request record;
  v_holder record;
BEGIN
  IF p_opportunity_id IS NULL THEN RETURN NULL; END IF;
  SELECT request_id, org_id, type INTO v_request
    FROM public.fence_job_mint_requests WHERE request_id = p_request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Read without a row lock: the holder's own complete step locks the holder
  -- row and then the job, while bind already holds the job. A completed holder
  -- never changes, and an in-flight one is followed to its result through the
  -- ownership chain, so the read needs no lock to stay correct.
  SELECT request_id, type, state, contact_id, job_id INTO v_holder
    FROM public.fence_job_mint_requests
    WHERE org_id = v_request.org_id AND opportunity_id = p_opportunity_id
      AND owner_request_id IS NULL AND state <> 'conflict'
      AND request_id <> p_request_id
    LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_holder.type <> v_request.type
    OR (v_holder.contact_id IS NOT NULL AND v_holder.contact_id <> p_contact_id)
    OR (v_holder.job_id IS NOT NULL AND p_job_id IS NOT NULL AND v_holder.job_id <> p_job_id)
    OR (v_holder.state = 'complete' AND v_holder.job_id IS NULL) THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_mapping_conflict', 'message', 'Opportunity is reserved by another mint request');
  END IF;

  UPDATE public.fence_job_mint_requests
    SET state = 'joined', owner_request_id = v_holder.request_id, contact_id = p_contact_id,
        opportunity_id = p_opportunity_id, job_id = COALESCE(p_job_id, v_holder.job_id),
        mapping_outcome = p_outcome, completed_at = NULL, updated_at = now()
    WHERE request_id = p_request_id;

  IF v_holder.state = 'complete' THEN
    RETURN jsonb_build_object(
      'decision', 'complete',
      'ownerRequestId', v_holder.request_id,
      'state', 'complete',
      'joined', true,
      'executor', false,
      'contactId', p_contact_id,
      'opportunityId', p_opportunity_id,
      'canonical', public._fence_mint_job_json(COALESCE(p_job_id, v_holder.job_id), p_outcome)
    );
  END IF;
  RETURN public._fence_mint_progress(p_request_id, true);
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_fence_job_mint(
  p_request_id uuid,
  p_org_id uuid,
  p_actor_id uuid,
  p_identity_key text,
  p_input_fingerprint text,
  p_intent text,
  p_contact_id text,
  p_opportunity_id text,
  p_expected_existing_job_ids uuid[],
  p_repeat_reason text,
  p_first_name text,
  p_last_name text,
  p_client_email text,
  p_client_phone text,
  p_site_address text,
  p_site_suburb text,
  p_type text DEFAULT 'fencing'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing record;
  v_lock record;
  v_owner record;
  v_root record;
  v_root_id uuid;
  v_reserved record;
  v_has_owner boolean := false;
  v_executor boolean := false;
BEGIN
  IF p_intent NOT IN ('RESOLVED_NO_JOB', 'DELIBERATE_REPEAT') OR p_identity_key IS NULL OR trim(p_identity_key) = ''
    OR p_type IS NULL OR p_type NOT IN ('fencing', 'patio') THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'invalid_mint_request', 'message', 'Invalid mint reservation');
  END IF;

  SELECT request_id, org_id, requested_by, type, intent, identity_key, input_fingerprint,
    state, owner_request_id, contact_id, opportunity_id, job_id,
    expected_existing_job_ids, repeat_reason, mapping_outcome, attempt_count,
    last_error_code, last_error_message, lease_expires_at, created_at, updated_at
  INTO v_existing FROM public.fence_job_mint_requests WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.org_id <> p_org_id OR v_existing.requested_by <> p_actor_id OR v_existing.input_fingerprint <> p_input_fingerprint
      OR v_existing.type <> p_type THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'idempotency_key_reused', 'message', 'requestId was already used with different caller or payload evidence');
    END IF;
    IF v_existing.state IN ('reserved', 'contact_resolved', 'opportunity_created')
      AND (v_existing.lease_expires_at IS NULL OR v_existing.lease_expires_at <= now()) THEN
      UPDATE public.fence_job_mint_requests
        SET attempt_count = attempt_count + 1, lease_expires_at = now() + interval '90 seconds',
            lease_holder_request_id = p_request_id, updated_at = now()
        WHERE request_id = p_request_id;
      v_executor := true;
    ELSIF v_existing.state = 'joined' THEN
      -- A takeover executor is recorded as 'joined' while executing on the owner
      -- row. Without re-election here its retry could never become executor
      -- again and the requestId would be permanently unmintable once the
      -- original owner's client is gone. Re-elect it against the live root owner
      -- whenever that owner's lease has lapsed.
      v_root_id := public._fence_mint_root_owner(p_request_id);
      IF v_root_id IS NOT NULL AND v_root_id <> p_request_id THEN
        SELECT request_id, state, lease_expires_at INTO v_root
          FROM public.fence_job_mint_requests WHERE request_id = v_root_id FOR UPDATE;
        IF FOUND THEN
          IF v_root.state IN ('reserved', 'contact_resolved', 'opportunity_created')
            AND (v_root.lease_expires_at IS NULL OR v_root.lease_expires_at <= now()) THEN
            UPDATE public.fence_job_mint_requests
              SET lease_expires_at = now() + interval '90 seconds', attempt_count = attempt_count + 1,
                  lease_holder_request_id = p_request_id, updated_at = now()
              WHERE request_id = v_root.request_id;
            v_executor := true;
          END IF;
        END IF;
      END IF;
      UPDATE public.fence_job_mint_requests
        SET attempt_count = attempt_count + 1, updated_at = now()
        WHERE request_id = p_request_id;
    ELSIF v_existing.state = 'conflict' AND v_existing.owner_request_id IS NULL
      AND v_existing.opportunity_id IS NULL AND v_existing.job_id IS NULL THEN
      -- A refusal with nothing bound is judged again on a retry of the same
      -- request id. It rejoins the identity lock exactly like a new request:
      -- a live owner is joined (and taken over once its lease lapses), so two
      -- concurrent mints for one identity still make exactly one job.
      INSERT INTO public.fence_job_mint_locks (org_id, type, identity_key)
      VALUES (v_existing.org_id, v_existing.type, v_existing.identity_key)
      ON CONFLICT (org_id, type, identity_key) DO NOTHING;
      SELECT org_id, type, identity_key, owner_request_id, updated_at
      INTO v_lock FROM public.fence_job_mint_locks
        WHERE org_id = v_existing.org_id AND type = v_existing.type AND identity_key = v_existing.identity_key
        FOR UPDATE;
      IF v_lock.owner_request_id IS NOT NULL AND v_lock.owner_request_id <> p_request_id THEN
        SELECT request_id, state, lease_expires_at INTO v_owner
          FROM public.fence_job_mint_requests WHERE request_id = v_lock.owner_request_id FOR UPDATE;
        v_has_owner := FOUND AND v_owner.state IN ('reserved', 'contact_resolved', 'opportunity_created');
      END IF;
      IF v_has_owner THEN
        IF v_owner.lease_expires_at IS NULL OR v_owner.lease_expires_at <= now() THEN
          UPDATE public.fence_job_mint_requests
            SET lease_expires_at = now() + interval '90 seconds', attempt_count = attempt_count + 1,
                lease_holder_request_id = p_request_id, updated_at = now()
            WHERE request_id = v_owner.request_id;
          v_executor := true;
        END IF;
        UPDATE public.fence_job_mint_requests
          SET state = 'joined', owner_request_id = v_owner.request_id,
              attempt_count = attempt_count + 1, updated_at = now()
          WHERE request_id = p_request_id;
        RETURN public._fence_mint_progress(p_request_id, true, v_executor);
      END IF;
      UPDATE public.fence_job_mint_requests
        SET state = 'reserved', contact_id = NULL, mapping_outcome = NULL,
            attempt_count = attempt_count + 1, lease_expires_at = now() + interval '90 seconds',
            lease_holder_request_id = p_request_id, updated_at = now()
        WHERE request_id = p_request_id;
      UPDATE public.fence_job_mint_locks
        SET owner_request_id = p_request_id, updated_at = now()
        WHERE org_id = v_existing.org_id AND type = v_existing.type AND identity_key = v_existing.identity_key;
      RETURN public._fence_mint_progress(p_request_id, false, true);
    ELSE
      UPDATE public.fence_job_mint_requests
        SET attempt_count = attempt_count + 1, updated_at = now()
        WHERE request_id = p_request_id;
    END IF;
    RETURN public._fence_mint_progress(p_request_id, v_existing.owner_request_id IS NOT NULL, v_executor);
  END IF;

  INSERT INTO public.fence_job_mint_locks (org_id, type, identity_key)
  VALUES (p_org_id, p_type, p_identity_key)
  ON CONFLICT (org_id, type, identity_key) DO NOTHING;

  SELECT org_id, type, identity_key, owner_request_id, updated_at
  INTO v_lock FROM public.fence_job_mint_locks
    WHERE org_id = p_org_id AND type = p_type AND identity_key = p_identity_key
    FOR UPDATE;

  IF v_lock.owner_request_id IS NOT NULL THEN
    SELECT request_id, org_id, requested_by, type, intent, identity_key, input_fingerprint,
      state, owner_request_id, contact_id, opportunity_id, job_id,
      expected_existing_job_ids, repeat_reason, mapping_outcome, lease_expires_at, created_at, updated_at
    INTO v_owner FROM public.fence_job_mint_requests WHERE request_id = v_lock.owner_request_id;
    v_has_owner := FOUND;
  END IF;

  IF v_has_owner THEN
    IF v_owner.state IN ('reserved', 'contact_resolved', 'opportunity_created') THEN
      IF v_owner.lease_expires_at IS NULL OR v_owner.lease_expires_at <= now() THEN
        UPDATE public.fence_job_mint_requests
          SET lease_expires_at = now() + interval '90 seconds', attempt_count = attempt_count + 1,
              lease_holder_request_id = p_request_id, updated_at = now()
          WHERE request_id = v_owner.request_id;
        v_executor := true;
      END IF;
      INSERT INTO public.fence_job_mint_requests (
        request_id, org_id, requested_by, type, intent, identity_key, input_fingerprint,
        state, owner_request_id, contact_id, opportunity_id, expected_existing_job_ids,
        repeat_reason, first_name, last_name, client_email, client_phone, site_address, site_suburb,
        attempt_count
      ) VALUES (
        p_request_id, p_org_id, p_actor_id, p_type, p_intent, p_identity_key, p_input_fingerprint,
        'joined', v_owner.request_id, p_contact_id, p_opportunity_id, COALESCE(p_expected_existing_job_ids, '{}'),
        p_repeat_reason, p_first_name, p_last_name, p_client_email, p_client_phone, p_site_address, p_site_suburb,
        1
      );
      RETURN public._fence_mint_progress(p_request_id, true, v_executor);
    END IF;
  END IF;

  INSERT INTO public.fence_job_mint_requests (
    request_id, org_id, requested_by, type, intent, identity_key, input_fingerprint,
    state, contact_id, opportunity_id, expected_existing_job_ids, repeat_reason,
    first_name, last_name, client_email, client_phone, site_address, site_suburb,
    attempt_count, lease_expires_at, lease_holder_request_id
  ) VALUES (
    p_request_id, p_org_id, p_actor_id, p_type, p_intent, p_identity_key, p_input_fingerprint,
    'reserved', p_contact_id, p_opportunity_id, COALESCE(p_expected_existing_job_ids, '{}'), p_repeat_reason,
    p_first_name, p_last_name, p_client_email, p_client_phone, p_site_address, p_site_suburb,
    1, now() + interval '90 seconds', p_request_id
  );

  UPDATE public.fence_job_mint_locks
    SET owner_request_id = p_request_id, updated_at = now()
    WHERE org_id = p_org_id AND type = p_type AND identity_key = p_identity_key;

  RETURN public._fence_mint_progress(p_request_id, false, true);
EXCEPTION WHEN unique_violation THEN
  -- Two simultaneous retries carrying the same requestId can both reach an
  -- INSERT. The loser replays the canonical ledger instead of failing opaquely.
  -- A violation of the opportunity reservation index instead leaves no row for
  -- this request, and is a caller-resolvable mapping collision, not a 5xx.
  IF EXISTS (SELECT 1 FROM public.fence_job_mint_requests WHERE request_id = p_request_id) THEN
    RETURN public._fence_mint_progress(p_request_id, false, false);
  END IF;
  -- An opportunity that a prior mint already completed against stays reserved by
  -- that completed row. A later requestId re-entering the same known lead must
  -- resolve to that completed canonical job rather than conflict forever or mint
  -- a duplicate. Only an identity mismatch is a real conflict.
  IF p_opportunity_id IS NOT NULL THEN
    SELECT request_id, org_id, state, contact_id, opportunity_id, job_id
    INTO v_reserved FROM public.fence_job_mint_requests
      WHERE org_id = p_org_id AND opportunity_id = p_opportunity_id
        AND owner_request_id IS NULL AND state <> 'conflict'
      LIMIT 1;
    IF FOUND THEN
      IF v_reserved.state = 'complete'
        AND (p_contact_id IS NULL OR v_reserved.contact_id IS NULL OR v_reserved.contact_id = p_contact_id) THEN
        -- Flagged explicitly: nothing here was concurrent. A caller must be able to
        -- tell re-entering a long-completed lead from a two-device race, so this
        -- branch never reports as concurrent_request_reused.
        RETURN public._fence_mint_progress(v_reserved.request_id, true, false)
          || jsonb_build_object('completedReentry', true);
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_mapping_conflict', 'message', 'Opportunity is reserved by another mint request');
END;
$$;



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
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_mapping_conflict', 'message', 'Opportunity is reserved by another mint request');
END;
$$;


REVOKE ALL ON FUNCTION public._fence_mint_settle_held_opportunity(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_fence_job_mint(uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_fence_job_mint_identity(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_fence_job_mint(uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_fence_job_mint_identity(uuid, text, text) TO service_role;
