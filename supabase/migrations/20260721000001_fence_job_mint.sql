-- Authenticated, idempotent fencing job mint.
--
-- This migration is additive. It does not replace the legacy patio/decking
-- create_contact_and_opportunity/create_job path. The Edge command reserves a
-- request before GHL IO; these RPCs serialize identity decisions and atomically
-- bind the permanent job UUID, SWF number and GHL mappings.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS scope_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS scope_updated_at timestamptz;

-- Production preflight MUST prove this query returns zero rows before apply:
-- SELECT org_id, type, ghl_opportunity_id, count(*)
-- FROM public.jobs WHERE ghl_opportunity_id IS NOT NULL
-- GROUP BY 1,2,3 HAVING count(*) > 1;
-- If it does not, stop. Do not choose a winner inside this migration.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_org_type_ghl_opportunity
  ON public.jobs (org_id, type, ghl_opportunity_id)
  WHERE ghl_opportunity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fence_job_mint_requests (
  request_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organisations(id),
  requested_by uuid NOT NULL REFERENCES public.users(id),
  type text NOT NULL DEFAULT 'fencing' CHECK (type = 'fencing'),
  intent text NOT NULL CHECK (intent IN ('RESOLVED_NO_JOB', 'DELIBERATE_REPEAT')),
  identity_key text NOT NULL,
  input_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'joined', 'contact_resolved', 'opportunity_created', 'complete', 'conflict')),
  owner_request_id uuid REFERENCES public.fence_job_mint_requests(request_id),
  contact_id text,
  opportunity_id text,
  job_id uuid REFERENCES public.jobs(id),
  expected_existing_job_ids uuid[] NOT NULL DEFAULT '{}',
  repeat_reason text,
  first_name text,
  last_name text,
  client_email text,
  client_phone text,
  site_address text,
  site_suburb text,
  mapping_outcome text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  last_error_message text,
  lease_expires_at timestamptz,
  -- The request currently elected to execute against this row. Identity, not
  -- expiry, is what authorises a delegated write: a legitimate execution can
  -- outlive the lease, while a stale delegate loses the grant the moment another
  -- request is elected.
  lease_holder_request_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_request_id IS NULL OR owner_request_id <> request_id),
  CHECK (intent <> 'DELIBERATE_REPEAT' OR length(trim(repeat_reason)) >= 3),
  CHECK (state <> 'complete' OR (job_id IS NOT NULL AND contact_id IS NOT NULL AND opportunity_id IS NOT NULL))
);

ALTER TABLE public.fence_job_mint_requests
  ADD COLUMN IF NOT EXISTS lease_holder_request_id uuid;

CREATE INDEX IF NOT EXISTS idx_fence_mint_requests_identity
  ON public.fence_job_mint_requests (org_id, type, identity_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fence_mint_requests_contact
  ON public.fence_job_mint_requests (org_id, type, contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fence_mint_request_opportunity
  ON public.fence_job_mint_requests (org_id, opportunity_id)
  WHERE opportunity_id IS NOT NULL AND owner_request_id IS NULL AND state <> 'conflict';

-- One lock row is the database-enforced serialization point for a contact/type
-- identity. Distinct request IDs race on this row and join the current owner.
CREATE TABLE IF NOT EXISTS public.fence_job_mint_locks (
  org_id uuid NOT NULL REFERENCES public.organisations(id),
  type text NOT NULL CHECK (type = 'fencing'),
  identity_key text NOT NULL,
  owner_request_id uuid REFERENCES public.fence_job_mint_requests(request_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, type, identity_key)
);

ALTER TABLE public.fence_job_mint_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fence_job_mint_locks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public._fence_mint_job_json(p_job_id uuid, p_outcome text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'jobId', j.id,
    'jobNumber', j.job_number,
    'contactId', j.ghl_contact_id,
    'opportunityId', j.ghl_opportunity_id,
    'mappingOutcome', p_outcome,
    'scopeVersion', COALESCE(j.scope_version, 1),
    'updatedAt', j.updated_at,
    -- Never read or transfer scope_json through mint. Only a job that this mint
    -- created AND whose scope is still genuinely empty may use the known
    -- empty-scope cursor. scope_version alone is not a freshness signal: the
    -- normal save_scope path writes scope_json without bumping it, so a replay
    -- months after real scope was saved would otherwise be told the scope is
    -- blank. Emptiness is tested here, never transferred, so a stale client can
    -- never start from a blank scope and overwrite saved work.
    'scopeHash', CASE
      WHEN p_outcome IN ('created', 'deliberate_repeat_created')
        AND COALESCE(j.scope_version, 1) = 1
        AND j.scope_updated_at IS NULL
        AND COALESCE(j.scope_json, '{}'::jsonb) = '{}'::jsonb
      THEN '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
      ELSE NULL END,
    'requiresLoad', NOT (
      p_outcome IN ('created', 'deliberate_repeat_created')
      AND COALESCE(j.scope_version, 1) = 1
      AND j.scope_updated_at IS NULL
      AND COALESCE(j.scope_json, '{}'::jsonb) = '{}'::jsonb
    )
  )
  FROM public.jobs j
  WHERE j.id = p_job_id
$$;

-- Existing-job evidence is compared as a set. Client-supplied order is never
-- load bearing, so both sides are normalised to sorted distinct arrays.
CREATE OR REPLACE FUNCTION public._fence_mint_sorted_uuids(p_ids uuid[])
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT id ORDER BY id), '{}'::uuid[])
  FROM unnest(COALESCE(p_ids, '{}'::uuid[])) AS id
$$;

-- Root of a mint ownership chain, bounded and cycle guarded. NULL means the
-- chain could not be resolved and the caller must not act on it.
CREATE OR REPLACE FUNCTION public._fence_mint_root_owner(p_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := p_request_id;
  v_next uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
BEGIN
  FOR v_hop IN 1..8 LOOP
    IF v_id = ANY(v_seen) THEN RETURN NULL; END IF;
    v_seen := v_seen || v_id;
    SELECT owner_request_id INTO v_next FROM public.fence_job_mint_requests WHERE request_id = v_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF v_next IS NULL THEN RETURN v_id; END IF;
    v_id := v_next;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._fence_mint_progress(
  p_request_id uuid,
  p_joined boolean DEFAULT false,
  p_executor boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request record;
  v_owner record;
  v_job record;
  v_owner_id uuid;
  v_seen uuid[];
BEGIN
  SELECT request_id, org_id, requested_by, type, intent, identity_key, input_fingerprint,
    state, owner_request_id, contact_id, opportunity_id, job_id,
    expected_existing_job_ids, repeat_reason, mapping_outcome,
    last_error_code, last_error_message, created_at, updated_at
  INTO v_request FROM public.fence_job_mint_requests WHERE request_id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'mint_request_not_found', 'message', 'Mint request was not found');
  END IF;

  -- Ownership is reassignable more than once: a reserve-time join points at an
  -- owner that a later bind-time join can itself repoint at a third request. One
  -- hop stops on an intermediate 'joined' row that never completes, stranding the
  -- caller on 'continue' forever. The chain is followed to its root instead,
  -- bounded and cycle guarded; a chain that does not terminate is ledger
  -- corruption rather than work still in flight.
  v_owner_id := v_request.request_id;
  v_seen := ARRAY[]::uuid[];
  FOR v_hop IN 1..8 LOOP
    IF v_owner_id = ANY(v_seen) THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'mint_owner_chain_corrupt', 'message', 'Mint ownership chain contains a cycle');
    END IF;
    v_seen := v_seen || v_owner_id;
    SELECT request_id, org_id, requested_by, type, intent, identity_key, input_fingerprint,
      state, owner_request_id, contact_id, opportunity_id, job_id,
      expected_existing_job_ids, repeat_reason, mapping_outcome, attempt_count,
      last_error_code, last_error_message, created_at, updated_at
    INTO v_owner FROM public.fence_job_mint_requests WHERE request_id = v_owner_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'mint_owner_not_found', 'message', 'Canonical mint owner was not found');
    END IF;
    EXIT WHEN v_owner.owner_request_id IS NULL;
    v_owner_id := v_owner.owner_request_id;
  END LOOP;
  IF v_owner.owner_request_id IS NOT NULL THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'mint_owner_chain_corrupt', 'message', 'Mint ownership chain exceeded the maximum resolvable depth');
  END IF;

  IF v_owner.state = 'complete' AND v_owner.job_id IS NOT NULL THEN
    SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
    INTO v_job FROM public.jobs WHERE id = v_owner.job_id AND org_id = v_owner.org_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('decision', 'conflict', 'code', 'canonical_job_missing', 'message', 'Completed mint points to a missing job');
    END IF;
    RETURN jsonb_build_object(
      'decision', 'complete',
      'ownerRequestId', v_owner.request_id,
      'state', 'complete',
      'joined', p_joined OR v_request.owner_request_id IS NOT NULL,
      'executor', false,
      'contactId', v_owner.contact_id,
      'opportunityId', v_owner.opportunity_id,
      'canonical', public._fence_mint_job_json(v_job.id, COALESCE(v_owner.mapping_outcome, 'idempotent_replay'))
    );
  END IF;

  IF v_owner.state = 'conflict' THEN
    RETURN jsonb_build_object(
      'decision', 'conflict',
      'code', COALESCE(v_owner.last_error_code, 'mint_conflict'),
      'message', COALESCE(v_owner.last_error_message, 'Mint request has conflicting identity evidence')
    );
  END IF;

  RETURN jsonb_build_object(
    'decision', 'continue',
    'ownerRequestId', v_owner.request_id,
    'state', v_owner.state,
    'joined', p_joined OR v_request.owner_request_id IS NOT NULL,
    'executor', p_executor,
    'contactId', v_owner.contact_id,
    'opportunityId', v_owner.opportunity_id,
    -- The executing row's attempt count is the durable record of whether an
    -- outbound create was ever attempted for this mint. A first attempt cannot
    -- have created anything, so the edge skips lost-response reconciliation.
    'attemptCount', COALESCE(v_owner.attempt_count, 1),
    'canonical', NULL
  );
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
        IF FOUND AND v_root.state IN ('reserved', 'contact_resolved', 'opportunity_created')
          AND (v_root.lease_expires_at IS NULL OR v_root.lease_expires_at <= now()) THEN
          UPDATE public.fence_job_mint_requests
            SET lease_expires_at = now() + interval '90 seconds', attempt_count = attempt_count + 1,
                lease_holder_request_id = p_request_id, updated_at = now()
            WHERE request_id = v_root.request_id;
          v_executor := true;
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

  IF v_has_owner AND v_owner.state IN ('reserved', 'contact_resolved', 'opportunity_created') THEN
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
    IF FOUND AND v_reserved.state = 'complete'
      AND (p_contact_id IS NULL OR v_reserved.contact_id IS NULL OR v_reserved.contact_id = p_contact_id) THEN
      -- Flagged explicitly: nothing here was concurrent. A caller must be able to
      -- tell re-entering a long-completed lead from a two-device race, so this
      -- branch never reports as concurrent_request_reused.
      RETURN public._fence_mint_progress(v_reserved.request_id, true, false)
        || jsonb_build_object('completedReentry', true);
    END IF;
  END IF;
  RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_mapping_conflict', 'message', 'Opportunity is reserved by another mint request');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_fence_job_mint_progress(p_request_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._fence_mint_progress(p_request_id, true, false)
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
  VALUES (v_request.org_id, 'fencing', v_contact_key)
  ON CONFLICT (org_id, type, identity_key) DO NOTHING;
  SELECT org_id, type, identity_key, owner_request_id, updated_at
  INTO v_lock FROM public.fence_job_mint_locks
    WHERE org_id = v_request.org_id AND type = 'fencing' AND identity_key = v_contact_key
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
    WHERE org_id = v_request.org_id AND type = 'fencing' AND identity_key = v_contact_key;

  IF p_opportunity_id IS NOT NULL THEN
    SELECT id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at
    INTO v_job FROM public.jobs
      WHERE org_id = v_request.org_id AND type = 'fencing' AND ghl_opportunity_id = p_opportunity_id
      LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF v_job.ghl_contact_id IS NOT NULL AND v_job.ghl_contact_id <> p_contact_id THEN
        RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_contact_conflict', 'message', 'Opportunity is mapped to a job for a different contact');
      END IF;
      UPDATE public.jobs SET ghl_contact_id = COALESCE(ghl_contact_id, p_contact_id), updated_at = now() WHERE id = v_job.id
      RETURNING id, org_id, status, ghl_contact_id, ghl_opportunity_id, job_number, scope_version, updated_at INTO v_job;
      UPDATE public.fence_job_mint_requests SET state = 'opportunity_created', contact_id = p_contact_id,
        opportunity_id = p_opportunity_id, job_id = v_job.id, mapping_outcome = 'existing_opportunity_reused',
        completed_at = NULL, updated_at = now() WHERE request_id = v_request.request_id;
      RETURN public._fence_mint_progress(v_request.request_id, false);
    END IF;
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_jobs
  FROM public.jobs
  WHERE org_id = v_request.org_id AND type = 'fencing' AND ghl_contact_id = p_contact_id
    AND status::text NOT IN ('complete', 'cancelled', 'invoiced', 'lost');

  -- DELIBERATE_REPEAT is governed by its expected-evidence check below, which is
  -- the stronger guard. Blocking it here would make repeat intent unreachable for
  -- any contact that already has two or more active fencing jobs.
  IF cardinality(v_jobs) > 1 AND v_request.intent <> 'DELIBERATE_REPEAT' THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'multiple_active_jobs', 'message', 'Contact maps to multiple active fencing jobs', 'jobIds', to_jsonb(v_jobs));
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
      UPDATE public.fence_job_mint_requests SET state = 'complete', contact_id = p_contact_id,
        opportunity_id = v_job.ghl_opportunity_id, job_id = v_job.id, mapping_outcome = 'concurrent_request_reused',
        completed_at = now(), updated_at = now() WHERE request_id = v_request.request_id;
      RETURN public._fence_mint_progress(v_request.request_id, true);
    END IF;
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'stale_existing_job_evidence', 'message', 'Existing-job evidence changed; refresh before creating another job', 'jobIds', to_jsonb(v_jobs));
  END IF;

  -- Historical rows without contact mapping are never treated as "none".
  SELECT count(*) INTO v_candidate_count FROM public.jobs
  WHERE org_id = v_request.org_id AND type = 'fencing' AND ghl_contact_id IS NULL
    AND status::text NOT IN ('cancelled', 'lost')
    AND (
      (COALESCE(trim(v_request.client_email), '') <> '' AND lower(trim(client_email)) = lower(trim(v_request.client_email))) OR
      (COALESCE(regexp_replace(v_request.client_phone, '[^0-9]+', '', 'g'), '') <> '' AND regexp_replace(client_phone, '[^0-9]+', '', 'g') = regexp_replace(v_request.client_phone, '[^0-9]+', '', 'g')) OR
      (COALESCE(lower(trim(v_request.site_address)), '') <> '' AND lower(trim(site_address)) = lower(trim(v_request.site_address)))
    );
  IF v_candidate_count > 0 THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'ambiguous_historical_mapping', 'message', 'A historical fencing job matches this identity but has no verified GHL contact mapping', 'candidateCount', v_candidate_count);
  END IF;

  UPDATE public.fence_job_mint_requests SET state = 'contact_resolved', contact_id = p_contact_id,
    opportunity_id = COALESCE(p_opportunity_id, opportunity_id), updated_at = now()
  WHERE request_id = v_request.request_id;
  RETURN public._fence_mint_progress(v_request.request_id, false);
EXCEPTION WHEN unique_violation THEN
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
  IF FOUND AND v_mapped.ghl_contact_id IS NOT NULL AND v_mapped.ghl_contact_id <> p_contact_id THEN
    RETURN jsonb_build_object('decision', 'conflict', 'code', 'opportunity_contact_conflict', 'message', 'Opportunity is already mapped to another contact job');
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
  IF FOUND AND (v_job.ghl_contact_id IS NULL OR v_job.ghl_contact_id = v_request.contact_id) THEN
    UPDATE public.fence_job_mint_requests SET state = 'complete', job_id = v_job.id,
      contact_id = v_request.contact_id, opportunity_id = v_request.opportunity_id,
      mapping_outcome = 'concurrent_request_reused', completed_at = now(), updated_at = now()
    WHERE request_id = v_request.request_id;
    RETURN public._fence_mint_progress(v_request.request_id, true);
  END IF;
  RETURN jsonb_build_object('decision', 'conflict', 'code', 'mapping_uniqueness_conflict', 'message', 'A concurrent job mapping could not be reconciled safely');
END;
$$;

-- Failure telemetry expires the target's lease, so it is a privileged write.
-- A caller may only stamp a row it owns, or the owner row it is currently
-- executing against as a takeover executor. Without this, submitting another
-- tenant's requestId would repeatedly expire that live mint's lease.
-- Reports why the stamp did or did not apply, so a silently dropped failure
-- write is observable at the edge instead of reading as success. The outcome
-- separates benign races (the row completed concurrently, or this delegate's
-- election was legitimately superseded) from a genuinely rejected executor
-- write, which is the only case that should page an operator.
DROP FUNCTION IF EXISTS public.record_fence_job_mint_failure(uuid, text, text, uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.record_fence_job_mint_failure(
  p_request_id uuid,
  p_code text,
  p_message text,
  p_org_id uuid,
  p_actor_id uuid,
  p_executing_request_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stamped uuid;
  v_row record;
BEGIN
  UPDATE public.fence_job_mint_requests r
  SET last_error_code = left(p_code, 120), last_error_message = left(p_message, 1000),
      state = CASE WHEN p_code IN (
        'contact_identity_conflict', 'contact_mapping_conflict',
        'opportunity_contact_conflict', 'opportunity_pipeline_conflict',
        'opportunity_mapping_conflict', 'contact_opportunity_job_conflict',
        'multiple_active_jobs', 'stale_existing_job_evidence',
        'ambiguous_historical_mapping', 'duplicate_stamped_opportunities',
        'mapping_uniqueness_conflict', 'bound_job_missing',
        'bound_job_identity_conflict'
      ) THEN 'conflict' ELSE r.state END,
      lease_expires_at = now(), updated_at = now()
  WHERE r.request_id = p_request_id AND r.state <> 'complete'
    AND r.org_id = p_org_id
    AND (
      r.requested_by = p_actor_id
      -- A takeover executor may stamp the owner row it is actually executing on.
      -- The grant is bound to that owner still recording this exact request as
      -- its elected lease holder, not to the lease still being unexpired: a
      -- legitimate execution (contact create, opportunity create, an ambiguous
      -- retry's reconciliation scan) can outlive the 90s lease, and keying on
      -- expiry silently dropped the write so the real typed conflict never
      -- surfaced. Election identity still expires the grant for a stale
      -- delegate, because electing any other executor overwrites the holder.
      -- Ownership is matched against the resolved root of the executing row's
      -- chain, not its direct parent: bind can repoint an intermediate owner, so
      -- a two hop chain executes on a root that is not its owner_request_id.
      OR (
        p_executing_request_id IS NOT NULL
        AND r.lease_holder_request_id = p_executing_request_id
        AND EXISTS (
          SELECT 1 FROM public.fence_job_mint_requests c
          WHERE c.request_id = p_executing_request_id
            AND public._fence_mint_root_owner(c.request_id) = r.request_id
            AND c.org_id = p_org_id AND c.requested_by = p_actor_id
        )
      )
    )
  RETURNING r.request_id INTO v_stamped;
  IF v_stamped IS NOT NULL THEN
    RETURN 'applied';
  END IF;

  SELECT state, requested_by, lease_holder_request_id INTO v_row
    FROM public.fence_job_mint_requests
    WHERE request_id = p_request_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN 'no_row';
  END IF;
  IF v_row.state = 'complete' THEN
    RETURN 'already_complete';
  END IF;
  IF v_row.requested_by <> p_actor_id
     AND p_executing_request_id IS NOT NULL
     AND v_row.lease_holder_request_id IS DISTINCT FROM p_executing_request_id THEN
    RETURN 'lease_revoked';
  END IF;
  RETURN 'denied';
END;
$$;

REVOKE ALL ON TABLE public.fence_job_mint_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fence_job_mint_locks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fence_mint_job_json(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fence_mint_sorted_uuids(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fence_mint_root_owner(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fence_mint_progress(uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_fence_job_mint_progress(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_fence_job_mint(uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_fence_job_mint_identity(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_fence_job_mint_opportunity(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_fence_job_mint(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_fence_job_mint_failure(uuid, text, text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_fence_job_mint(uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_fence_job_mint_progress(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_fence_job_mint_identity(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_fence_job_mint_opportunity(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_fence_job_mint(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_fence_job_mint_failure(uuid, text, text, uuid, uuid, uuid) TO service_role;

COMMENT ON TABLE public.fence_job_mint_requests IS
  'Server-owned fencing mint ledger. Same request UUID resumes; contact/type races serialize through fence_job_mint_locks. Contains no send or approval action.';
