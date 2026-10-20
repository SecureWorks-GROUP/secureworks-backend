-- 20261020170000_job_media_signature_voice_note_phases.sql
--
-- The trade app's completion wizard saves the client's signature as a
-- job_media row with phase 'signature' (trade.html wizUploadSignature) and the
-- trade's voice summary with phase 'voice_note' (wizUploadAudio, and the end of
-- day voice summary). ops-api confirm_upload inserts the row and throws on any
-- error. Neither phase has ever been in job_media_phase_check (newest
-- definition 20261009120000_quote_builder_versions.sql), so both inserts are
-- refused and the wizard stops before complete_my_job: a client who signs on
-- site leaves a job the wizard cannot complete. The completion pack already
-- prints a stored signature under "Client Acceptance"
-- (completion-pack/index.ts, phase 'signature').
--
-- Same class as 20260908100000, which added the wizard's 'marketing' phase.
-- This adds 'signature' and 'voice_note' and keeps every existing value. It
-- writes no row and changes no existing row.
ALTER TABLE public.job_media DROP CONSTRAINT IF EXISTS job_media_phase_check;
ALTER TABLE public.job_media ADD CONSTRAINT job_media_phase_check
  CHECK (phase IN ('scope', 'in_progress', 'completion', 'receipt', 'marketing', 'neighbour_signoff', 'issue', 'quote_builder', 'signature', 'voice_note'));
