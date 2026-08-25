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
