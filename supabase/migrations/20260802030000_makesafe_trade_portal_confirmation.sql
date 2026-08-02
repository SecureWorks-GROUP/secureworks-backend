-- Admit the SECOND approved producer of portal-completion evidence.
--
-- Captain ruling, 2026-08-02 (portal-producer-and-voice-notes.md section 1):
-- any trade assigned to the job may confirm that the builder's roof report was
-- completed on the Prime link. The deterministic reader and the trade tick are
-- two producers of the SAME fact, so the trade tick lands on this same
-- append-only ledger rather than in a parallel store.
--
-- The two producers differ in exactly one way, and this migration is where that
-- difference is enforced:
--
--   capture_portal_evidence.py/v1  renders the Prime page, so it MUST carry the
--                                  stored screenshot that proves what it saw.
--   trade_portal_confirmation/v1   renders nothing. Its proof is the named
--                                  authenticated confirmer in captured_by, so
--                                  it carries NO screenshot, and it is confined
--                                  to the single role the ruling names (roof)
--                                  and the single result an attestation can
--                                  honestly make (done).
--
-- Widening only. No row is written, no column is dropped, no existing row can
-- become invalid: every persisted row today carries the reader's producer and
-- keeps exactly the shape it had to satisfy before.

ALTER TABLE public.makesafe_portal_capture_revisions
  DROP CONSTRAINT IF EXISTS makesafe_portal_capture_bridge_shape;
ALTER TABLE public.makesafe_portal_capture_revisions
  ADD CONSTRAINT makesafe_portal_capture_bridge_shape CHECK (
    role IN ('roof_report', 'assessment', 'photos', 'scope')
    AND capture_result IN ('done', 'not_done', 'unreachable')
    AND source_url ~ '^https://'
    AND source_content_hash ~ '^sha256:[0-9a-f]{64}$'
    AND length(btrim(captured_by)) > 0
    AND capture_producer IN (
      'capture_portal_evidence.py/v1',
      'trade_portal_confirmation/v1'
    )
    AND length(btrim(capture_idempotency_key)) > 0
    AND length(btrim(signal)) > 0
    AND jsonb_array_length(evidence_refs) > 0
    AND (
      (capture_result = 'done' AND status = 'verified')
      OR (capture_result = 'not_done' AND status = 'captured')
      OR (capture_result = 'unreachable' AND status = 'rejected')
    )
    AND (
      (
        capture_producer = 'capture_portal_evidence.py/v1'
        AND (
          (
            capture_result IN ('done', 'not_done')
            AND screenshot_object_key LIKE
              'makesafe-docket-artifacts/portal-captures/%'
            AND screenshot_media_type = 'image/png'
            AND screenshot_content_hash ~ '^sha256:[0-9a-f]{64}$'
            AND screenshot_size_bytes > 0
          )
          OR (
            capture_result = 'unreachable'
            AND screenshot_object_key IS NULL
            AND screenshot_media_type IS NULL
            AND screenshot_content_hash IS NULL
            AND screenshot_size_bytes IS NULL
          )
        )
      )
      OR (
        capture_producer = 'trade_portal_confirmation/v1'
        AND role = 'roof_report'
        AND capture_result = 'done'
        AND screenshot_object_key IS NULL
        AND screenshot_media_type IS NULL
        AND screenshot_content_hash IS NULL
        AND screenshot_size_bytes IS NULL
      )
    )
  );

-- One confirmation per card per attendance cycle, whoever ticks first. The
-- runtime derives its idempotency key from the cycle alone, which already makes
-- a repeat tick converge; this index is the DATABASE guard that makes two
-- trades ticking at the same instant converge too, without depending on how the
-- key happens to be derived.
CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_trade_portal_confirmation
  ON public.makesafe_portal_capture_revisions (
    job_id,
    attendance_cycle_id,
    role
  )
  WHERE capture_producer = 'trade_portal_confirmation/v1';

COMMENT ON TABLE public.makesafe_portal_capture_revisions IS
  'Append-only current-cycle portal evidence from the two approved producers: capture_portal_evidence.py/v1 (headless Prime reader, screenshot-bearing) and trade_portal_confirmation/v1 (an assigned trade answering "Is this roof report done?", roof-only, no screenshot). U4 consumes only the screenshot-bearing reader; the board read model and M1 accept either. Nothing here derives or moves a board stage.';
COMMENT ON COLUMN
  public.makesafe_portal_capture_revisions.capture_producer IS
  'Which approved producer wrote this row. It is the ONLY thing that tells apart a rendered observation from a human attestation, so every consumer that needs a screenshot must select on it rather than on the presence of screenshot columns.';
COMMENT ON COLUMN
  public.makesafe_portal_capture_revisions.source_content_hash IS
  'Producer-specific fingerprint. For capture_portal_evidence.py/v1 it is the SHA-256 of the rendered Prime content the producer classified. For trade_portal_confirmation/v1 nothing is rendered, so it is the SHA-256 of the attestation itself (job, cycle, role, link, builder reference, confirming user, timestamp, question and answer). Distinct in both cases from the screenshot byte hash and the aggregate makesafe_content_hash.';
COMMENT ON COLUMN
  public.makesafe_portal_capture_revisions.captured_by IS
  'The producer''s identity for a reader row, and the authenticated user id of the confirming trade for an attestation row. An attestation has no screenshot, so this column is its provenance.';
