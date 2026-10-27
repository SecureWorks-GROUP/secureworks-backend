-- Prerequisites for 20261020170000_job_media_signature_voice_note_phases: job_media with the
-- quote builder phase check (20261009120000), which an earlier registered setup creates.
DO $$
BEGIN
 IF to_regclass('public.job_media') IS NULL THEN
  RAISE EXCEPTION 'signature phase setup: job_media missing from the registered stack';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_media_phase_check'
                AND conrelid = 'public.job_media'::regclass
                AND pg_get_constraintdef(oid) LIKE '%quote_builder%') THEN
  RAISE EXCEPTION 'signature phase setup: job_media_phase_check is not the 20261009120000 definition';
 END IF;
END $$;
