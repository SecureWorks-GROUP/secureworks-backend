-- Quote builder v1: versioned scopes and variations for one job.
--
-- Contract: docs/quote-builder-contract.md. Writer: ops-api
-- (supabase/functions/ops-api/quote_builder.ts). This migration adds ONE table
-- and one partial index on jobs, and changes nothing an existing caller does:
--
--   quote_builder_versions holds every saved version of a job's scope chain and
--   of each variation chain: Hugo's write-up, the internal cost lines (what it
--   costs us), the client charge lines (what we charge), server-computed totals,
--   the photos chosen for that version (job_media ids) and, once issued, the
--   client quote PDF (a job_documents row).
--
-- Why a new table: quote_revisions is send-quote's SENT release ledger
-- (released_via is limited to the send paths, a recipient and a release
-- manifest are required), jobs.scope_json belongs to the fence and patio
-- scoping tools, and jobs.expected_costs is frozen once at acceptance. None of
-- them can hold an unsent, editable, versioned scope with internal costs.
--
-- Rules the database enforces:
--   * one version number per (job, chain); a race on the same number is a
--     unique violation, never a silent overwrite;
--   * a variation chain names a chain of its own (chain_id <> job_id) and the
--     scope chain is the job's own id (chain_id = job_id);
--   * an issued version is frozen: no UPDATE and no DELETE (trigger);
--   * least privilege: RLS on with no policy, revoked from anon and
--     authenticated, so internal cost lines are reachable only through ops-api.
--   * a private quote job is minted once per request: one miscellaneous job
--     per metadata.quote_builder.request_id (built-in jsonb operators only, so
--     every role that writes jobs can maintain the index).
--
-- Rollback: supabase/rollbacks/20261009120000_quote_builder_versions_down.sql.

CREATE TABLE IF NOT EXISTS public.quote_builder_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  chain_id uuid NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  title text,
  narrative text,
  cost_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  charge_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_total_ex_gst numeric(12,2) NOT NULL DEFAULT 0,
  charge_total_ex_gst numeric(12,2) NOT NULL DEFAULT 0,
  charge_gst numeric(12,2) NOT NULL DEFAULT 0,
  charge_total_inc_gst numeric(12,2) NOT NULL DEFAULT 0,
  margin_ex_gst numeric(12,2) NOT NULL DEFAULT 0,
  margin_pct numeric(7,2),
  photo_media_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  client_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  variation_id uuid REFERENCES public.job_variations(id) ON DELETE RESTRICT,
  client_pdf_document_id uuid REFERENCES public.job_documents(id) ON DELETE RESTRICT,
  quote_number text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  issued_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_builder_versions_kind_valid CHECK (kind IN ('scope', 'variation')),
  CONSTRAINT quote_builder_versions_status_valid CHECK (status IN ('draft', 'issued')),
  CONSTRAINT quote_builder_versions_version_positive CHECK (version > 0),
  CONSTRAINT quote_builder_versions_chain_shape CHECK (
    (kind = 'scope' AND chain_id = job_id AND variation_id IS NULL)
    OR (kind = 'variation' AND chain_id <> job_id)
  ),
  CONSTRAINT quote_builder_versions_lines_are_arrays CHECK (
    jsonb_typeof(cost_lines) = 'array' AND jsonb_typeof(charge_lines) = 'array'
  ),
  CONSTRAINT quote_builder_versions_issue_complete CHECK (
    status = 'draft'
    OR (issued_at IS NOT NULL AND client_pdf_document_id IS NOT NULL AND quote_number IS NOT NULL)
  ),
  CONSTRAINT quote_builder_versions_unique_chain_version UNIQUE (job_id, chain_id, version)
);

CREATE INDEX IF NOT EXISTS quote_builder_versions_job_idx
  ON public.quote_builder_versions (job_id, kind, chain_id, version DESC);
CREATE INDEX IF NOT EXISTS quote_builder_versions_variation_idx
  ON public.quote_builder_versions (variation_id) WHERE variation_id IS NOT NULL;

COMMENT ON TABLE public.quote_builder_versions IS
  'Quote builder scope and variation versions (docs/quote-builder-contract.md). Written only by ops-api; issued rows are frozen.';
COMMENT ON COLUMN public.quote_builder_versions.chain_id IS
  'Scope chain = job_id; each variation has its own chain id. Versions number 1.. within a chain.';
COMMENT ON COLUMN public.quote_builder_versions.cost_lines IS
  'Internal cost lines (what it costs us). Never on the client PDF, never sent to trades.';
COMMENT ON COLUMN public.quote_builder_versions.charge_lines IS
  'Client charge lines (what we charge). The client quote PDF shows these.';

CREATE OR REPLACE FUNCTION public.quote_builder_versions_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'issued' THEN
      RAISE EXCEPTION 'quote_builder_versions: issued version % is frozen and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'issued' THEN
    RAISE EXCEPTION 'quote_builder_versions: issued version % is frozen', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'quote_builder_versions: identity columns of version % cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_quote_builder_versions_guard ON public.quote_builder_versions;
CREATE TRIGGER trg_quote_builder_versions_guard
  BEFORE UPDATE OR DELETE ON public.quote_builder_versions
  FOR EACH ROW EXECUTE FUNCTION public.quote_builder_versions_guard();

ALTER TABLE public.quote_builder_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quote_builder_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.quote_builder_versions TO service_role;
REVOKE ALL ON FUNCTION public.quote_builder_versions_guard() FROM PUBLIC, anon, authenticated;

CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_quote_builder_request_id
  ON public.jobs ((metadata -> 'quote_builder' ->> 'request_id'))
  WHERE type = 'miscellaneous'
    AND (metadata -> 'quote_builder' ->> 'request_id') IS NOT NULL;
