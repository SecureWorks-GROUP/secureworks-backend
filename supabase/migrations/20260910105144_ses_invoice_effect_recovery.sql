-- Invoice effect recovery is deliberately narrower than route redispatch.
-- Only an immutable invoice effect whose stored failure proves that the
-- provider mutation was never called may acquire this new dispatch lease.
-- Historical dispatching/unknown rows remain held until an exact provider
-- reconciliation proves their outcome.

CREATE OR REPLACE FUNCTION public.claim_ses_invoice_no_dispatch_retry_v1(
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
  now_at timestamptz;
  next_expiry timestamptz;
BEGIN
  IF jsonb_typeof(p_expectation) IS DISTINCT FROM 'object'
     OR btrim(COALESCE(p_expectation->>'effect_id', '')) !~
       '^[0-9a-fA-F-]{36}$'
     OR btrim(COALESCE(p_expectation->>'invoice_obligation_revision_id', '')) !~
       '^[0-9a-fA-F-]{36}$'
     OR btrim(COALESCE(p_expectation->>'operation_key', '')) = ''
     OR btrim(COALESCE(p_expectation->>'effect_kind', '')) <> 'invoice_create'
     OR btrim(COALESCE(p_expectation->>'external_token', '')) = ''
     OR btrim(COALESCE(p_expectation->>'payload_hash', '')) = ''
     OR btrim(COALESCE(p_expectation->>'state', '')) <> 'failed'
     OR btrim(COALESCE(p_lease_owner, '')) = ''
     OR btrim(COALESCE(p_actor, '')) = ''
     OR p_lease_seconds IS NULL
     OR p_lease_seconds < 10
     OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'valid failed invoice effect expectation and lease are required'
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
  WHERE id = (p_expectation->>'effect_id')::uuid
    AND invoice_obligation_revision_id =
      (p_expectation->>'invoice_obligation_revision_id')::uuid
    AND operation_key = btrim(p_expectation->>'operation_key')
    AND effect_kind = 'invoice_create'
    AND effect_kind = btrim(p_expectation->>'effect_kind')
    AND external_token = btrim(p_expectation->>'external_token')
    AND payload_hash = btrim(p_expectation->>'payload_hash')
    AND state = 'failed'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF target.failure->>'disposition' IS DISTINCT FROM 'definite_no_dispatch'
     OR target.failure->>'proof' IS DISTINCT FROM 'provider_called_false'
     OR target.failure->'provider_called' IS DISTINCT FROM 'false'::jsonb
     OR target.failure->'provider_call_made' IS DISTINCT FROM 'false'::jsonb
     OR NULLIF(btrim(COALESCE(target.external_id, '')), '') IS NOT NULL THEN
    RETURN NULL;
  END IF;
  -- The proof must have been retained by the narrow state transition that
  -- recorded the pre-mutation refusal. A service-role caller cannot turn a
  -- hand-written failure JSON value into a retry lease without its append-only
  -- event evidence.
  IF NOT EXISTS (
    SELECT 1
    FROM public.ses_external_effect_events event
    WHERE event.effect_id = target.id
      AND event.from_state IN ('reserved', 'dispatching')
      AND event.to_state = 'failed'
      AND event.event_kind IN (
        'preflight_refused_before_dispatch',
        'dispatch_refused_before_provider'
      )
      AND event.detail->'failure' = target.failure
  ) THEN
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
    'failed',
    'dispatching',
    'definite_no_dispatch_redispatch_claimed',
    jsonb_build_object(
      'proof', 'provider_called_false',
      'failure', target.failure,
      'lease_owner', p_lease_owner,
      'lease_expires_at', next_expiry
    ),
    p_actor
  );
  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ses_invoice_no_dispatch_retry_v1(jsonb, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ses_invoice_no_dispatch_retry_v1(jsonb, text, text, integer)
  TO service_role;

COMMENT ON FUNCTION public.claim_ses_invoice_no_dispatch_retry_v1(jsonb, text, text, integer)
  IS 'Leases only a failed immutable invoice effect whose stored provider_called:false proof makes a same-token retry safe; ambiguous effects remain held.';
