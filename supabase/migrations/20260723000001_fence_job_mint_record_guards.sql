-- Correct PL/pgSQL record guards in the fencing mint RPCs.
--
-- SELECT ... INTO an untyped record leaves that record structurally unassigned
-- when no row is found. PL/pgSQL does not safely short-circuit expressions such
-- as `FOUND AND record.field = ...`: resolving record.field can raise SQLSTATE
-- 55000 before the false FOUND value is applied. The initial production dry
-- reserve exposed this on v_owner. All five occurrences use nested FOUND/owner
-- guards here so a no-row result is handled before any record field is read.
--
-- Applying this migration performs no outbound communication and executes no
-- job or mint row DML. It only replaces three RPC definitions and restores their
-- grants; later RPC calls retain the original guarded write behaviour.

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
  p_site_suburb text
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
  IF p_intent NOT IN ('RESOLVED_NO_JOB', 'DELIBERATE_REPEAT') OR p_identity_key IS NULL OR trim(p_identity_key) = '' THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'invalid_mint_request', 'message', 'Invalid mint reservation');
  END IF;

  SELECT request_id, org_id, requested_by, type, intent, identity_key, input_fingerprint,
    state, owner_request_id, contact_id, opportunity_id, job_id,
    expected_existing_job_ids, repeat_reason, mapping_outcome, attempt_count,
    last_error_code, last_error_message, lease_expires_at, created_at, updated_at
  INTO v_existing FROM public.fence_job_mint_requests WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.org_id <> p_org_id OR v_existing.requested_by <> p_actor_id OR v_existing.input_fingerprint <> p_input_fingerprint THEN
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
    ELSE
      UPDATE public.fence_job_mint_requests
        SET attempt_count = attempt_count + 1, updated_at = now()
        WHERE request_id = p_request_id;
    END IF;
    RETURN public._fence_mint_progress(p_request_id, v_existing.owner_request_id IS NOT NULL, v_executor);
  END IF;

  INSERT INTO public.fence_job_mint_locks (org_id, type, identity_key)
  VALUES (p_org_id, 'fencing', p_identity_key)
  ON CONFLICT (org_id, type, identity_key) DO NOTHING;

  SELECT org_id, type, identity_key, owner_request_id, updated_at
  INTO v_lock FROM public.fence_job_mint_locks
    WHERE org_id = p_org_id AND type = 'fencing' AND identity_key = p_identity_key
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
        request_id, org_id, requested_by, intent, identity_key, input_fingerprint,
        state, owner_request_id, contact_id, opportunity_id, expected_existing_job_ids,
        repeat_reason, first_name, last_name, client_email, client_phone, site_address, site_suburb,
        attempt_count
      ) VALUES (
        p_request_id, p_org_id, p_actor_id, p_intent, p_identity_key, p_input_fingerprint,
        'joined', v_owner.request_id, p_contact_id, p_opportunity_id, COALESCE(p_expected_existing_job_ids, '{}'),
        p_repeat_reason, p_first_name, p_last_name, p_client_email, p_client_phone, p_site_address, p_site_suburb,
        1
      );
      RETURN public._fence_mint_progress(p_request_id, true, v_executor);
    END IF;
  END IF;

  INSERT INTO public.fence_job_mint_requests (
    request_id, org_id, requested_by, intent, identity_key, input_fingerprint,
    state, contact_id, opportunity_id, expected_existing_job_ids, repeat_reason,
    first_name, last_name, client_email, client_phone, site_address, site_suburb,
    attempt_count, lease_expires_at, lease_holder_request_id
  ) VALUES (
    p_request_id, p_org_id, p_actor_id, p_intent, p_identity_key, p_input_fingerprint,
    'reserved', p_contact_id, p_opportunity_id, COALESCE(p_expected_existing_job_ids, '{}'), p_repeat_reason,
    p_first_name, p_last_name, p_client_email, p_client_phone, p_site_address, p_site_suburb,
    1, now() + interval '90 seconds', p_request_id
  );

  UPDATE public.fence_job_mint_locks
    SET owner_request_id = p_request_id, updated_at = now()
    WHERE org_id = p_org_id AND type = 'fencing' AND identity_key = p_identity_key;

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

CREATE OR REPLACE FUNCTION public.record_fence_job_mint_opportunity(
  p_request_id uuid,
  p_opportunity_id text,
  p_contact_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request record;
  v_mapped record;
BEGIN
  SELECT request_id, org_id, requested_by, type, intent, state, owner_request_id,
    contact_id, opportunity_id, job_id, mapping_outcome, created_at, updated_at
  INTO v_request FROM public.fence_job_mint_requests WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('decision', 'conflict', 'code', 'mint_request_not_found', 'message', 'Mint request was not found'); END IF;
  IF v_request.owner_request_id IS NOT NULL OR v_request.state = 'complete' THEN RETURN public._fence_mint_progress(v_request.request_id, v_request.owner_request_id IS NOT NULL); END IF;
  IF v_request.contact_id IS NULL OR v_request.contact_id <> p_contact_id THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_contact_conflict', 'message', 'Opportunity contact does not match the reserved contact');
  END IF;
  IF v_request.opportunity_id IS NOT NULL AND v_request.opportunity_id <> p_opportunity_id THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_mapping_conflict', 'message', 'Mint request already carries a different opportunity');
  END IF;

  SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
  INTO v_mapped FROM public.jobs
    WHERE org_id = v_request.org_id AND type = 'fencing' AND ghl_opportunity_id = p_opportunity_id
    LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_mapped.ghl_contact_id IS NOT NULL AND v_mapped.ghl_contact_id <> p_contact_id THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_contact_conflict', 'message', 'Opportunity is already mapped to another contact job');
    END IF;
  END IF;

  UPDATE public.fence_job_mint_requests SET state = 'opportunity_created', opportunity_id = p_opportunity_id,
    updated_at = now(), last_error_code = NULL, last_error_message = NULL
  WHERE request_id = v_request.request_id;
  RETURN public._fence_mint_progress(v_request.request_id, false);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_mapping_conflict', 'message', 'Opportunity is reserved by another mint request');
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_fence_job_mint(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request record;
  v_job record;
  v_jobs uuid[];
  v_job_number text;
  v_job_id uuid;
  v_outcome text;
BEGIN
  SELECT request_id, org_id, requested_by, type, intent, state, owner_request_id,
    contact_id, opportunity_id, job_id, expected_existing_job_ids,
    first_name, last_name, client_email, client_phone, site_address, site_suburb,
    mapping_outcome, created_at, updated_at
  INTO v_request FROM public.fence_job_mint_requests WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('decision', 'conflict', 'code', 'mint_request_not_found', 'message', 'Mint request was not found'); END IF;
  IF v_request.owner_request_id IS NOT NULL OR v_request.state = 'complete' THEN RETURN public._fence_mint_progress(v_request.request_id, v_request.owner_request_id IS NOT NULL); END IF;
  IF v_request.contact_id IS NULL OR v_request.opportunity_id IS NULL THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'mint_identity_incomplete', 'message', 'Contact and opportunity must be recorded before job creation');
  END IF;

  SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
  INTO v_job FROM public.jobs
    WHERE org_id = v_request.org_id AND type = 'fencing' AND ghl_opportunity_id = v_request.opportunity_id
    LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_job.ghl_contact_id IS NOT NULL AND v_job.ghl_contact_id <> v_request.contact_id THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_contact_conflict', 'message', 'Opportunity maps to a job for another contact');
    END IF;
    UPDATE public.jobs SET ghl_contact_id = COALESCE(ghl_contact_id, v_request.contact_id), updated_at = now() WHERE id = v_job.id
    RETURNING id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at INTO v_job;
    v_outcome := COALESCE(v_request.mapping_outcome, 'existing_opportunity_reused');
  ELSIF v_request.job_id IS NOT NULL THEN
    -- Bind already resolved this mint onto an existing job. Idempotency requires
    -- the same canonical result on every retry, so a status change after bind
    -- (including complete or invoiced) must never cause a second job to be
    -- minted. Only broken identity may end this branch, and it ends it typed.
    SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
    INTO v_job FROM public.jobs WHERE id = v_request.job_id AND org_id = v_request.org_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'bound_job_missing', 'message', 'The job bound to this mint no longer exists');
    END IF;
    IF (v_job.ghl_contact_id IS NOT NULL AND v_job.ghl_contact_id <> v_request.contact_id)
      OR (v_job.ghl_opportunity_id IS NOT NULL AND v_job.ghl_opportunity_id <> v_request.opportunity_id) THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'bound_job_identity_conflict', 'message', 'The job bound to this mint now carries different contact or opportunity identity');
    END IF;
    UPDATE public.jobs SET ghl_contact_id = COALESCE(ghl_contact_id, v_request.contact_id),
      ghl_opportunity_id = COALESCE(ghl_opportunity_id, v_request.opportunity_id), updated_at = now()
    WHERE id = v_job.id
    RETURNING id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at INTO v_job;
    v_outcome := COALESCE(v_request.mapping_outcome, 'existing_contact_job_reused');
  ELSE
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_jobs FROM public.jobs
      WHERE org_id = v_request.org_id AND type = 'fencing' AND ghl_contact_id = v_request.contact_id
        AND status::text NOT IN ('complete', 'cancelled', 'invoiced', 'lost');

    IF v_request.intent = 'RESOLVED_NO_JOB' AND cardinality(v_jobs) = 1 THEN
      SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
      INTO v_job FROM public.jobs WHERE id = v_jobs[1] FOR UPDATE;
      IF v_job.ghl_opportunity_id IS NOT NULL AND v_job.ghl_opportunity_id <> v_request.opportunity_id THEN
        RETURN jsonb_build_object('decision', 'conflict', 'code', 'contact_opportunity_job_conflict', 'message', 'Contact gained a differently mapped active job during mint');
      END IF;
      UPDATE public.jobs SET ghl_opportunity_id = v_request.opportunity_id, updated_at = now() WHERE id = v_job.id
      RETURNING id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at INTO v_job;
      v_outcome := 'existing_contact_job_reused';
    ELSIF v_request.intent = 'RESOLVED_NO_JOB' AND cardinality(v_jobs) > 1 THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'multiple_active_jobs', 'message', 'Contact gained multiple active jobs during mint');
    ELSIF v_request.intent = 'DELIBERATE_REPEAT' AND v_jobs <> public._fence_mint_sorted_uuids(v_request.expected_existing_job_ids) THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'stale_existing_job_evidence', 'message', 'Existing-job evidence changed during mint');
    ELSE
      SELECT public.next_job_number('fencing') INTO v_job_number;
      INSERT INTO public.jobs (
        org_id, created_by, status, type, client_name, client_phone, client_email,
        site_address, site_suburb, ghl_contact_id, ghl_opportunity_id, job_number,
        scope_json, scope_version, scope_updated_at
      ) VALUES (
        v_request.org_id, v_request.requested_by, 'draft', 'fencing',
        trim(concat_ws(' ', v_request.first_name, v_request.last_name)), v_request.client_phone, v_request.client_email,
        v_request.site_address, v_request.site_suburb, v_request.contact_id, v_request.opportunity_id, v_job_number,
        '{}'::jsonb, 1, NULL
      ) RETURNING id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at INTO v_job;
      v_outcome := CASE WHEN v_request.intent = 'DELIBERATE_REPEAT' THEN 'deliberate_repeat_created' ELSE 'created' END;
    END IF;
  END IF;

  IF v_job.job_number IS NULL THEN
    v_job_id := v_job.id;
    SELECT public.next_job_number('fencing') INTO v_job_number;
    UPDATE public.jobs SET job_number = v_job_number, updated_at = now() WHERE id = v_job_id AND job_number IS NULL
    RETURNING id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at INTO v_job;
    IF NOT FOUND THEN
      SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
      INTO v_job FROM public.jobs WHERE id = v_job_id;
    END IF;
  END IF;

  UPDATE public.fence_job_mint_requests SET state = 'complete', job_id = v_job.id,
    contact_id = v_job.ghl_contact_id, opportunity_id = v_job.ghl_opportunity_id,
    mapping_outcome = v_outcome, completed_at = now(), updated_at = now(),
    last_error_code = NULL, last_error_message = NULL
  WHERE request_id = v_request.request_id;

  INSERT INTO public.job_events (job_id, user_id, event_type, detail_json)
  VALUES (v_job.id, v_request.requested_by,
    CASE WHEN v_outcome IN ('created', 'deliberate_repeat_created') THEN 'job_created' ELSE 'fence_job_mint_reused' END,
    jsonb_build_object(
      'source', 'fence_server_mint', 'mint_request_id', v_request.request_id,
      'mapping_outcome', v_outcome, 'caller_id', v_request.requested_by,
      'communication_sent', false
    )
  );

  RETURN public._fence_mint_progress(v_request.request_id, false);
EXCEPTION WHEN unique_violation THEN
  SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
  INTO v_job FROM public.jobs
    WHERE org_id = v_request.org_id AND type = 'fencing' AND ghl_opportunity_id = v_request.opportunity_id LIMIT 1;
  IF FOUND THEN
    IF v_job.ghl_contact_id IS NULL OR v_job.ghl_contact_id = v_request.contact_id THEN
      UPDATE public.fence_job_mint_requests SET state = 'complete', job_id = v_job.id,
        contact_id = v_request.contact_id, opportunity_id = v_request.opportunity_id,
        mapping_outcome = 'concurrent_request_reused', completed_at = now(), updated_at = now()
      WHERE request_id = v_request.request_id;
      RETURN public._fence_mint_progress(v_request.request_id, true);
    END IF;
  END IF;
  RETURN jsonb_build_object('decision', 'conflict', 'code', 'mapping_uniqueness_conflict', 'message', 'A concurrent job mapping could not be reconciled safely');
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_fence_job_mint(uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_fence_job_mint_opportunity(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_fence_job_mint(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_fence_job_mint(uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_fence_job_mint_opportunity(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_fence_job_mint(uuid) TO service_role;
