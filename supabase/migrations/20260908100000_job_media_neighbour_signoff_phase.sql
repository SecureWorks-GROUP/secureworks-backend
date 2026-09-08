-- Trade job completion evidence (Captain ask 2026-09-08).
-- Neighbour sign-off screenshots are job_media rows with phase
-- 'neighbour_signoff'. The completion wizard has uploaded 'marketing' photos
-- since 2026-03 against a check that never listed it; both are added here.
ALTER TABLE job_media DROP CONSTRAINT IF EXISTS job_media_phase_check;
ALTER TABLE job_media ADD CONSTRAINT job_media_phase_check
  CHECK (phase IN ('scope', 'in_progress', 'completion', 'receipt', 'marketing', 'neighbour_signoff', 'issue'));
CREATE INDEX IF NOT EXISTS idx_job_media_job_phase ON job_media(job_id, phase);
