-- Rollback for 20261020170000_job_media_signature_voice_note_phases.sql.
--
-- Refuses while any row uses either phase: a stored client signature or voice
-- note is evidence and is never deleted or relabelled to fit the narrower check.

BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.job_media WHERE phase IN ('signature', 'voice_note')) THEN
    RAISE EXCEPTION 'job_media holds signature or voice_note rows: resolve them before rolling back 20261020170000_job_media_signature_voice_note_phases';
  END IF;
END $$;

ALTER TABLE public.job_media DROP CONSTRAINT IF EXISTS job_media_phase_check;
ALTER TABLE public.job_media ADD CONSTRAINT job_media_phase_check
  CHECK (phase IN ('scope', 'in_progress', 'completion', 'receipt', 'marketing', 'neighbour_signoff', 'issue', 'quote_builder'));

COMMIT;
