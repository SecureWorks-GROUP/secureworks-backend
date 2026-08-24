-- Allow a read-only reconciliation to close the SES authorise ledger when a
-- legacy AUTHORISED Xero invoice was adopted outside the SES dispatch path.
-- This does not authorise, create, void, or otherwise mutate Xero.

CREATE OR REPLACE FUNCTION public.transition_ses_external_effect_v1(
  p_operation_key text,
  p_from_state text,
  p_to_state text,
  p_event_kind text,
  p_detail jsonb,
  p_actor text
)
RETURNS public.ses_external_effects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.ses_external_effects%ROWTYPE;
  observed_authorise boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-effect:' || btrim(p_operation_key), 0)
  );
  SELECT * INTO target
  FROM public.ses_external_effects
  WHERE operation_key = btrim(p_operation_key)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'external effect does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF target.state IS DISTINCT FROM p_from_state THEN
    RAISE EXCEPTION 'external effect state changed; reconcile the existing operation'
      USING ERRCODE = '40001';
  END IF;
  observed_authorise :=
    p_from_state = 'reserved'
    AND p_to_state = 'confirmed'
    AND p_event_kind = 'provider_observed_without_dispatch'
    AND target.effect_kind = 'invoice_authorise'
    AND btrim(COALESCE(p_detail->>'external_id', '')) <> '';
  IF NOT (
    (p_from_state = 'reserved' AND p_to_state IN ('dispatching', 'failed'))
    OR observed_authorise
    OR (p_from_state = 'dispatching' AND p_to_state IN ('unknown', 'confirmed', 'failed'))
    OR (p_from_state = 'unknown' AND p_to_state IN ('confirmed', 'failed'))
    OR (p_from_state = 'failed' AND p_to_state IN ('unknown', 'confirmed', 'compensated'))
    OR (p_from_state = 'confirmed' AND p_to_state = 'compensated')
  ) THEN
    RAISE EXCEPTION 'invalid external effect transition % -> %', p_from_state, p_to_state
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.ses_external_effects
  SET
    state = p_to_state,
    external_id = COALESCE(NULLIF(p_detail->>'external_id', ''), external_id),
    provider_digest = CASE
      WHEN p_detail ? 'provider_digest' THEN p_detail->'provider_digest'
      ELSE provider_digest
    END,
    failure = CASE
      WHEN p_detail ? 'failure' THEN p_detail->'failure'
      ELSE failure
    END,
    updated_at = clock_timestamp(),
    confirmed_at = CASE
      WHEN p_to_state = 'confirmed' THEN clock_timestamp()
      ELSE confirmed_at
    END
  WHERE id = target.id
  RETURNING * INTO target;

  INSERT INTO public.ses_external_effect_events (
    effect_id, from_state, to_state, event_kind, detail, actor
  ) VALUES (
    target.id, p_from_state, p_to_state, p_event_kind,
    COALESCE(p_detail, '{}'::jsonb), p_actor
  );
  RETURN target;
END;
$$;

COMMENT ON FUNCTION public.transition_ses_external_effect_v1(text, text, text, text, jsonb, text)
  IS 'SES effect state machine; permits only an exact provider-observed legacy invoice authorise reconciliation from reserved to confirmed.';
