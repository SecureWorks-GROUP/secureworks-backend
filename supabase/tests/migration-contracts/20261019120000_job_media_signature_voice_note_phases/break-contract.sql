-- Break: put the 20261009120000 check back, so a signature row is refused again.
ALTER TABLE public.job_media DROP CONSTRAINT IF EXISTS job_media_phase_check;
ALTER TABLE public.job_media ADD CONSTRAINT job_media_phase_check
  CHECK (phase IN ('scope', 'in_progress', 'completion', 'receipt', 'marketing', 'neighbour_signoff', 'issue', 'quote_builder'));
