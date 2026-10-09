-- Down for 20261009120000_quote_builder_versions. Drops the quote builder table, its guard and
-- the private-job request index on jobs, and narrows the job_media phase check back to its
-- earlier list while no row uses the 'quote_builder' phase (once one does, the wider check stays
-- so those photos remain valid rows).
-- Run only before any version has been issued in production: issued rows are the record of what
-- was quoted, and dropping the table discards them. The job_documents rows and job_media photos
-- the builder wrote are ordinary rows in those tables and are left in place.
DROP INDEX IF EXISTS public.ux_jobs_quote_builder_request_id;
DROP TABLE IF EXISTS public.quote_builder_versions;
DROP FUNCTION IF EXISTS public.quote_builder_versions_guard();
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.job_media WHERE phase = 'quote_builder') THEN
    ALTER TABLE public.job_media DROP CONSTRAINT IF EXISTS job_media_phase_check;
    ALTER TABLE public.job_media ADD CONSTRAINT job_media_phase_check
      CHECK (phase IN ('scope', 'in_progress', 'completion', 'receipt', 'marketing', 'neighbour_signoff', 'issue'));
  END IF;
END $$;
