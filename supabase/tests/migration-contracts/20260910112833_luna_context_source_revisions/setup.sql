-- Synthetic table shapes for the registered PostgreSQL contracts only.
-- jobs and API roles are supplied by the earlier registered fixtures.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS ghl_contact_id text;
CREATE TABLE public.contact_matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, ghl_contact_id text);
CREATE TABLE public.business_events (
  id uuid PRIMARY KEY, job_id text, payload jsonb NOT NULL DEFAULT '{}',
  match_status text, match_method text, contact_id text, metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.inbox_events (
  id uuid PRIMARY KEY, job_id uuid, metadata jsonb NOT NULL DEFAULT '{}',
  ghl_contact_id text, body_preview text, received_at timestamptz DEFAULT now()
);
CREATE TABLE public.job_events (
  id uuid PRIMARY KEY, job_id uuid, detail_json jsonb NOT NULL DEFAULT '{}', created_at timestamptz DEFAULT now()
);
CREATE TABLE public.job_context (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES public.jobs(id), kind text NOT NULL,
  value jsonb NOT NULL, provenance jsonb NOT NULL, correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.job_temporary_context (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES public.jobs(id),
  kind text NOT NULL CHECK (kind IN ('current_state','pending_action','quote_issue')),
  value jsonb NOT NULL, provenance jsonb NOT NULL, correlation_id uuid,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, UPDATE ON public.business_events, public.inbox_events, public.job_events TO service_role;
GRANT SELECT ON public.jobs, public.contact_matches TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.job_context, public.job_temporary_context TO service_role;
