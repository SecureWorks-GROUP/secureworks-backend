-- T7 Loop 1 — Evidence storage bucket creation (DRAFT — NOT YET APPLIED)
--
-- Status: draft only. Apply only after explicit user approval. The first
-- two buckets (evidence-bodies, evidence-attachments) apply in Loop 3.
-- The audio/transcript buckets stay drafted until Loop 7 + the consent ADR.
--
-- Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 4)
--
-- Storage bucket policies follow the same pattern as
-- 20260501140000_create_release_manifests_bucket.sql (private, service-role
-- only for write, no public read).
--
-- Buckets created here:
--   evidence-bodies      : full email bodies, full notes, SMS/Telegram text overflow
--   evidence-attachments : email attachments where no job match yet (orphan/)
--   evidence-audio       : call recordings (Loop 7 + ADR before any live writes)
--   evidence-transcripts : WhisperFlow transcripts (Loop 7 + ADR)
--
-- Read access: ALL evidence buckets read via ops-api action
-- get_evidence_body(spine_event_id) which checks role + per-job RLS. No
-- direct authenticated read on the bucket itself.
--
-- Rollback:
--   DELETE FROM storage.buckets WHERE id IN
--     ('evidence-bodies','evidence-attachments','evidence-audio','evidence-transcripts');
--   DROP POLICY IF EXISTS "evidence_bucket_service_write" ON storage.objects;
--   DROP POLICY IF EXISTS "evidence_bucket_service_read"  ON storage.objects;
--   Time-to-revert: <2s. Buckets must be empty for delete to succeed.

BEGIN;

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('evidence-bodies',      'evidence-bodies',      false),
  ('evidence-attachments', 'evidence-attachments', false),
  ('evidence-audio',       'evidence-audio',       false),
  ('evidence-transcripts', 'evidence-transcripts', false)
ON CONFLICT (id) DO NOTHING;

-- Service role full write/read on all four buckets.
CREATE POLICY "evidence_bucket_service_write" ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id IN ('evidence-bodies','evidence-attachments','evidence-audio','evidence-transcripts'))
  WITH CHECK (bucket_id IN ('evidence-bodies','evidence-attachments','evidence-audio','evidence-transcripts'));

-- Authenticated has NO direct bucket access. Reads go through ops-api
-- get_evidence_body which checks role + per-job RLS before signing a URL
-- or returning bytes.
-- (No 'authenticated_read' policy intentionally.)

COMMIT;

-- Notes for Loop 7 (audio + transcripts):
-- The audio + transcript buckets remain dormant after this migration
-- applies. monitor-call worker stays disabled until both feature flags
-- (evidence_audio_capture, evidence_transcript_capture) are ON, which
-- requires Marnin's signed consent ADR. T7 builds the path; T7 does not
-- enable it.
