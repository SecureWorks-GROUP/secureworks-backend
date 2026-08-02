-- Rollback twin for 20260802030000_makesafe_trade_portal_confirmation.sql
--
-- Restores the single-producer U4 bridge shape and drops the trade-confirmation
-- uniqueness guard.
--
-- IMPORTANT: this rollback FAILS if any trade attestation has already been
-- written, because the restored CHECK admits only
-- 'capture_portal_evidence.py/v1'. That is deliberate — narrowing a CHECK must
-- never silently strand recorded evidence in a shape the constraint no longer
-- allows, and this ledger is append-only, so the answer is to decide what
-- happens to those confirmations, not to delete them here. This file never
-- writes or removes a row.

DROP INDEX IF EXISTS public.uq_makesafe_trade_portal_confirmation;

ALTER TABLE public.makesafe_portal_capture_revisions
  DROP CONSTRAINT IF EXISTS makesafe_portal_capture_bridge_shape;
ALTER TABLE public.makesafe_portal_capture_revisions
  ADD CONSTRAINT makesafe_portal_capture_bridge_shape CHECK (
    role IN ('roof_report', 'assessment', 'photos', 'scope')
    AND capture_result IN ('done', 'not_done', 'unreachable')
    AND source_url ~ '^https://'
    AND source_content_hash ~ '^sha256:[0-9a-f]{64}$'
    AND length(btrim(captured_by)) > 0
    AND capture_producer = 'capture_portal_evidence.py/v1'
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
  );

COMMENT ON TABLE public.makesafe_portal_capture_revisions IS
  'Append-only current-cycle evidence from the approved capture_portal_evidence.py producer. U4 consumes exact job/cycle/role/URL rows and never launches a browser in the Edge Function.';
COMMENT ON COLUMN
  public.makesafe_portal_capture_revisions.source_content_hash IS
  'SHA-256 fingerprint of the rendered Prime content classified by the approved producer; distinct from the screenshot byte hash and the aggregate makesafe_content_hash.';
