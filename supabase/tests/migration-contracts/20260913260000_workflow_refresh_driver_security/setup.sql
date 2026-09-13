-- Minimal pre-migration Refresh surface. This deliberately models the schema
-- immediately before the existing 20260913260000 migration so its contract
-- can capture the declaration-only completion that the next migration closes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
END $$;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS org_id uuid;

CREATE TABLE IF NOT EXISTS public.workflow_refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow text NOT NULL,
  scope jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','partial','failed')),
  source_cutoff timestamptz,
  requested_by text NOT NULL,
  lease_token uuid,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_refresh_runs_active
  ON public.workflow_refresh_runs (workflow, (scope::text))
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS public.dispatch_refresh_test_sources (
  org_id uuid NOT NULL,
  job_id uuid NOT NULL,
  revision text,
  PRIMARY KEY (org_id, job_id)
);

CREATE OR REPLACE FUNCTION public.workflow_refresh_scope_allowed(p_scope jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(p_scope) IS NOT DISTINCT FROM 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_scope) k
       WHERE k NOT IN ('job_id','org_id','week_start')
     );
$$;

-- Dispatch owns this function in production. The disposable fixture makes its
-- revision observable and lets the contracts exercise both missing and failed
-- source reads without reaching a live provider.
CREATE OR REPLACE FUNCTION public.dispatch_source_version(p_org uuid, p_job uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE source_revision text;
BEGIN
  SELECT revision INTO source_revision
    FROM public.dispatch_refresh_test_sources
   WHERE org_id=p_org AND job_id=p_job;
  IF source_revision = 'error' THEN RAISE EXCEPTION 'fixture_source_error'; END IF;
  RETURN source_revision;
END $$;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON public.jobs TO service_role;
GRANT SELECT, UPDATE ON public.dispatch_refresh_test_sources TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.workflow_refresh_runs TO service_role;
