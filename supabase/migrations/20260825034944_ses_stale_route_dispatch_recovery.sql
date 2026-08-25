-- Recover an expired SES route dispatch only after exact-token provider proof,
-- while fencing the previous dispatch generation before any later Graph send.
-- Every timeout decision uses the database clock and immutable ledger fields.

CREATE INDEX IF NOT EXISTS idx_ses_route_dispatching_lease
  ON public.ses_external_effects (lease_expires_at, release_revision_id)
  WHERE effect_kind = 'route_send' AND state = 'dispatching';

CREATE OR REPLACE FUNCTION public.inspect_stale_ses_route_dispatch_v1(
  p_expectation jsonb
)
RETURNS public.ses_external_effects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.ses_external_effects%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_expectation) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'stale dispatch expectation must be an object'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO target
  FROM public.ses_external_effects
  WHERE id = NULLIF(p_expectation->>'effect_id', '')::uuid
    AND release_revision_id = NULLIF(
      p_expectation->>'release_revision_id', ''
    )::uuid
    AND operation_key = btrim(p_expectation->>'operation_key')
    AND effect_kind = 'route_send'
    AND route_kind = btrim(p_expectation->>'route_kind')
    AND external_token = btrim(p_expectation->>'external_token')
    AND payload_hash = btrim(p_expectation->>'payload_hash')
    AND state = 'dispatching'
    AND lease_owner IS NOT DISTINCT FROM NULLIF(
      p_expectation->>'lease_owner', ''
    )
    AND lease_expires_at IS NOT DISTINCT FROM NULLIF(
      p_expectation->>'lease_expires_at', ''
    )::timestamptz
    AND lease_expires_at <= statement_timestamp();

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_stale_ses_route_dispatch_v1(
  p_expectation jsonb,
  p_outcome jsonb,
  p_actor text
)
RETURNS public.ses_external_effects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.ses_external_effects%ROWTYPE;
  outcome_kind text := btrim(COALESCE(p_outcome->>'kind', ''));
  match_count integer := COALESCE((p_outcome->>'match_count')::integer, -1);
  outcome_external_id text := btrim(COALESCE(p_outcome->>'external_id', ''));
  now_at timestamptz;
  event_kind text;
  event_detail jsonb;
BEGIN
  IF jsonb_typeof(p_expectation) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_outcome) IS DISTINCT FROM 'object'
     OR btrim(COALESCE(p_actor, '')) = ''
     OR outcome_kind NOT IN ('sent', 'no_send')
     OR (outcome_kind = 'sent' AND (
       match_count <> 1
       OR outcome_external_id = ''
       OR jsonb_typeof(p_outcome->'provider_digest') IS DISTINCT FROM 'object'
       OR btrim(COALESCE(
         p_outcome#>>'{provider_digest,message_id}', ''
       )) IS DISTINCT FROM outcome_external_id
       OR btrim(COALESCE(
         p_outcome#>>'{provider_digest,operation_token}', ''
       )) IS DISTINCT FROM btrim(COALESCE(
         p_expectation->>'external_token', ''
       ))
     ))
     OR (outcome_kind = 'no_send' AND match_count <> 0) THEN
    RAISE EXCEPTION 'valid exact stale dispatch outcome and actor are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'ses-effect:' || btrim(p_expectation->>'operation_key'),
      0
    )
  );
  SELECT * INTO target
  FROM public.ses_external_effects
  WHERE id = NULLIF(p_expectation->>'effect_id', '')::uuid
    AND release_revision_id = NULLIF(
      p_expectation->>'release_revision_id', ''
    )::uuid
    AND operation_key = btrim(p_expectation->>'operation_key')
    AND effect_kind = 'route_send'
    AND route_kind = btrim(p_expectation->>'route_kind')
    AND external_token = btrim(p_expectation->>'external_token')
    AND payload_hash = btrim(p_expectation->>'payload_hash')
    AND state = 'dispatching'
    AND lease_owner IS NOT DISTINCT FROM NULLIF(
      p_expectation->>'lease_owner', ''
    )
    AND lease_expires_at IS NOT DISTINCT FROM NULLIF(
      p_expectation->>'lease_expires_at', ''
    )::timestamptz
    AND lease_expires_at IS NOT NULL
  FOR UPDATE;

  now_at := clock_timestamp();
  IF NOT FOUND OR target.lease_expires_at > now_at THEN
    RETURN NULL;
  END IF;

  IF outcome_kind = 'sent' THEN
    UPDATE public.ses_external_effects
    SET state = 'confirmed',
        external_id = outcome_external_id,
        provider_digest = p_outcome->'provider_digest',
        failure = '{}'::jsonb,
        confirmed_at = now_at,
        updated_at = now_at
    WHERE id = target.id
    RETURNING * INTO target;
    event_kind := 'stale_dispatch_provider_confirmed';
    event_detail := jsonb_build_object(
      'reconciliation', 'graph_exact_token_read_only',
      'match_count', 1,
      'external_token', target.external_token,
      'external_id', target.external_id,
      'expired_lease_owner', p_expectation->>'lease_owner',
      'expired_lease_expires_at', p_expectation->>'lease_expires_at'
    );
  ELSE
    UPDATE public.ses_external_effects
    SET state = 'failed',
        failure = jsonb_build_object(
          'code', 'dispatch_lease_timeout',
          'message', 'The dispatch lease expired and exhaustive exact-token provider reconciliation proved no send.',
          'timed_out_at', now_at
        ),
        updated_at = now_at
    WHERE id = target.id
    RETURNING * INTO target;
    event_kind := 'dispatch_lease_timed_out_no_send';
    event_detail := jsonb_build_object(
      'reconciliation', 'graph_exact_token_read_only',
      'match_count', 0,
      'external_token', target.external_token,
      'expired_lease_owner', p_expectation->>'lease_owner',
      'expired_lease_expires_at', p_expectation->>'lease_expires_at',
      'timed_out_at', now_at
    );
  END IF;

  INSERT INTO public.ses_external_effect_events (
    effect_id, from_state, to_state, event_kind, detail, actor
  ) VALUES (
    target.id,
    'dispatching',
    target.state,
    event_kind,
    event_detail,
    p_actor
  );
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_ses_route_redispatch_v1(
  p_expectation jsonb,
  p_lease_owner text,
  p_actor text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS public.ses_external_effects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.ses_external_effects%ROWTYPE;
  prior_state text := btrim(COALESCE(p_expectation->>'state', ''));
  now_at timestamptz;
  next_expiry timestamptz;
BEGIN
  IF jsonb_typeof(p_expectation) IS DISTINCT FROM 'object'
     OR prior_state NOT IN ('unknown', 'failed')
     OR btrim(COALESCE(p_lease_owner, '')) = ''
     OR btrim(COALESCE(p_actor, '')) = ''
     OR p_lease_seconds IS NULL
     OR p_lease_seconds < 10
     OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'valid route redispatch expectation and lease are required'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'ses-effect:' || btrim(p_expectation->>'operation_key'),
      0
    )
  );
  SELECT * INTO target
  FROM public.ses_external_effects
  WHERE id = NULLIF(p_expectation->>'effect_id', '')::uuid
    AND release_revision_id = NULLIF(
      p_expectation->>'release_revision_id', ''
    )::uuid
    AND operation_key = btrim(p_expectation->>'operation_key')
    AND effect_kind = 'route_send'
    AND route_kind = btrim(p_expectation->>'route_kind')
    AND external_token = btrim(p_expectation->>'external_token')
    AND payload_hash = btrim(p_expectation->>'payload_hash')
    AND state = prior_state
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  now_at := clock_timestamp();
  next_expiry := now_at + make_interval(secs => p_lease_seconds);
  UPDATE public.ses_external_effects
  SET state = 'dispatching',
      lease_owner = p_lease_owner,
      lease_expires_at = next_expiry,
      updated_at = now_at
  WHERE id = target.id
  RETURNING * INTO target;

  INSERT INTO public.ses_external_effect_events (
    effect_id, from_state, to_state, event_kind, detail, actor
  ) VALUES (
    target.id,
    prior_state,
    'dispatching',
    'exact_token_absent_redispatch_claimed',
    jsonb_build_object(
      'reconciled_match_count', 0,
      'lease_owner', p_lease_owner,
      'lease_expires_at', next_expiry
    ),
    p_actor
  );
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_ses_route_dispatch_lease_v1(
  p_expectation jsonb,
  p_lease_seconds integer DEFAULT 900
)
RETURNS public.ses_external_effects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.ses_external_effects%ROWTYPE;
  now_at timestamptz;
  next_expiry timestamptz;
BEGIN
  IF jsonb_typeof(p_expectation) IS DISTINCT FROM 'object'
     OR btrim(COALESCE(p_expectation->>'lease_owner', '')) = ''
     OR p_lease_seconds IS NULL
     OR p_lease_seconds < 10
     OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'valid active dispatch generation and lease are required'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'ses-effect:' || btrim(p_expectation->>'operation_key'),
      0
    )
  );
  SELECT * INTO target
  FROM public.ses_external_effects
  WHERE id = NULLIF(p_expectation->>'effect_id', '')::uuid
    AND release_revision_id = NULLIF(
      p_expectation->>'release_revision_id', ''
    )::uuid
    AND operation_key = btrim(p_expectation->>'operation_key')
    AND effect_kind = 'route_send'
    AND route_kind = btrim(p_expectation->>'route_kind')
    AND external_token = btrim(p_expectation->>'external_token')
    AND payload_hash = btrim(p_expectation->>'payload_hash')
    AND state = 'dispatching'
    AND lease_owner = btrim(p_expectation->>'lease_owner')
    AND lease_expires_at IS NOT NULL
  FOR UPDATE;

  now_at := clock_timestamp();
  IF NOT FOUND OR target.lease_expires_at <= now_at THEN
    RETURN NULL;
  END IF;

  next_expiry := now_at + make_interval(secs => p_lease_seconds);
  UPDATE public.ses_external_effects
  SET lease_expires_at = next_expiry,
      updated_at = now_at
  WHERE id = target.id
  RETURNING * INTO target;

  INSERT INTO public.ses_external_effect_events (
    effect_id, from_state, to_state, event_kind, detail, actor
  ) VALUES (
    target.id,
    'dispatching',
    'dispatching',
    'dispatch_lease_renewed',
    jsonb_build_object(
      'lease_owner', target.lease_owner,
      'lease_expires_at', next_expiry
    ),
    target.lease_owner
  );
  RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.read_stuck_ses_route_dispatches_v1(
  p_job_ids uuid[]
)
RETURNS TABLE (
  job_id uuid,
  effect_id uuid,
  release_revision_id uuid,
  operation_key text,
  route_kind text,
  dispatch_started_at timestamptz,
  dispatch_age_seconds bigint,
  lease_owner text,
  lease_expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    member.job_id,
    effect.id AS effect_id,
    effect.release_revision_id,
    effect.operation_key,
    effect.route_kind,
    COALESCE(started.created_at, effect.created_at) AS dispatch_started_at,
    GREATEST(
      0,
      floor(extract(epoch FROM (
        statement_timestamp() - COALESCE(started.created_at, effect.created_at)
      )))
    )::bigint AS dispatch_age_seconds,
    effect.lease_owner,
    effect.lease_expires_at
  FROM public.ses_external_effects effect
  JOIN public.makesafe_release_revision_members member
    ON member.release_revision_id = effect.release_revision_id
  LEFT JOIN LATERAL (
    SELECT event.created_at
    FROM public.ses_external_effect_events event
    WHERE event.effect_id = effect.id
      AND event.event_kind IN (
        'dispatch_started',
        'exact_token_absent_redispatch_claimed'
      )
    ORDER BY event.id DESC
    LIMIT 1
  ) started ON true
  WHERE cardinality(COALESCE(p_job_ids, '{}'::uuid[])) > 0
    AND member.job_id = ANY(p_job_ids)
    AND effect.effect_kind = 'route_send'
    AND effect.state = 'dispatching'
    AND effect.lease_expires_at IS NOT NULL
    AND effect.lease_expires_at <= statement_timestamp()
  ORDER BY member.job_id, effect.lease_expires_at, effect.id;
$$;

REVOKE ALL ON FUNCTION public.inspect_stale_ses_route_dispatch_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_stale_ses_route_dispatch_v1(jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ses_route_redispatch_v1(jsonb, text, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_ses_route_dispatch_lease_v1(jsonb, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_stuck_ses_route_dispatches_v1(uuid[])
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.inspect_stale_ses_route_dispatch_v1(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_stale_ses_route_dispatch_v1(jsonb, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ses_route_redispatch_v1(jsonb, text, text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_ses_route_dispatch_lease_v1(jsonb, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.read_stuck_ses_route_dispatches_v1(uuid[])
  TO service_role;

COMMENT ON FUNCTION public.settle_stale_ses_route_dispatch_v1(jsonb, jsonb, text)
  IS 'Exact expired-lease CAS: Graph exact-token sent proof confirms; exhaustive no-send proof records timeout and makes the route retryable.';
COMMENT ON FUNCTION public.renew_ses_route_dispatch_lease_v1(jsonb, integer)
  IS 'Renews only the exact live route dispatch generation before Graph mutation; an expired or superseded worker receives no row and must not send.';
