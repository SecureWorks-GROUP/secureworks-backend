-- Additive connectivity between an intake source and an existing MakeSafe job.
-- This table is deliberately separate from intake authority corrections. A link
-- records adjudicated provenance only and cannot change replay or mint semantics.

CREATE TABLE public.makesafe_source_job_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL
    REFERENCES public.organisations(id) ON DELETE RESTRICT,
  source_post_id text NOT NULL
    REFERENCES public.emails(post_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL
    REFERENCES public.jobs(id) ON DELETE RESTRICT,
  match_key text NOT NULL CHECK (btrim(match_key) <> ''),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_source_job_links_pair_key
    UNIQUE (org_id, source_post_id, job_id)
);

CREATE INDEX idx_makesafe_source_job_links_source
  ON public.makesafe_source_job_links (org_id, source_post_id);

CREATE INDEX idx_makesafe_source_job_links_job
  ON public.makesafe_source_job_links (org_id, job_id);

ALTER TABLE public.makesafe_source_job_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_source_job_links FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.makesafe_source_job_links TO service_role;

CREATE POLICY service_role_read_makesafe_source_job_links
  ON public.makesafe_source_job_links
  FOR SELECT TO service_role USING (true);

CREATE TRIGGER trg_makesafe_source_job_links_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_source_job_links
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

COMMENT ON TABLE public.makesafe_source_job_links IS
  'Append-only adjudicated connectivity between an intake source and an existing MakeSafe job. This table does not alter intake authority or job lifecycle state.';
