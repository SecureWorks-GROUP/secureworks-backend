-- Unplaced stage 1 (20261014170000) reads three things no earlier registered
-- case creates: job_service_reports (context_job_dead) and the share tokens of
-- quotes and variations (context_link_ref_jobs). Shapes follow the live
-- columns the migration reads; nothing else of those tables is needed here.
CREATE TABLE IF NOT EXISTS public.job_service_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.job_documents ADD COLUMN IF NOT EXISTS share_token text;
ALTER TABLE public.job_variations ADD COLUMN IF NOT EXISTS share_token text;
