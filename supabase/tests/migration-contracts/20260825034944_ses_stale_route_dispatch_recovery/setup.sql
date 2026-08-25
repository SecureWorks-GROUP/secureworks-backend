-- Minimal pre-migration SES ledger surface for the disposable PostgreSQL suite.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.makesafe_release_revision_members (
  release_revision_id uuid NOT NULL,
  job_id uuid NOT NULL,
  PRIMARY KEY (release_revision_id, job_id)
);

CREATE TABLE IF NOT EXISTS public.ses_external_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE,
  org_id uuid NOT NULL,
  job_id uuid,
  effect_kind text NOT NULL,
  invoice_obligation_revision_id uuid,
  release_revision_id uuid,
  docket_revision_id uuid,
  route_kind text,
  artifact_hash text,
  payload_hash text NOT NULL,
  external_token text NOT NULL UNIQUE,
  state text NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  external_id text,
  provider_digest jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.ses_external_effect_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  effect_id uuid NOT NULL REFERENCES public.ses_external_effects(id),
  from_state text,
  to_state text NOT NULL,
  event_kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Production already has this RPC from the U5/U6 SES ledger migration. The
-- focused contract setup must reproduce that baseline because the recovery
-- contract proves a timed-out effect is clean after its supported confirm.
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
  IF NOT (
    (p_from_state = 'reserved' AND p_to_state IN ('dispatching', 'failed'))
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
