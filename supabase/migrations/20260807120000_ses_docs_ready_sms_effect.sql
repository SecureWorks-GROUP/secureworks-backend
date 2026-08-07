-- Docs Ready SMS effect (Harden SES v1, ticket 06).
--
-- Captain 2026-08-07: when a card newly reaches Docs Ready, Marnin gets ONE
-- SMS on the existing GHL path - his only ping from the whole system. The
-- send must be exact-once per job per attendance cycle: a re-persist of a new
-- docket revision for the same cycle, or a concurrent double prepare, must
-- never text him twice.
--
-- This migration adds effect_kind `docs_ready_sms` so the notify path can
-- claim an exact-once ledger row keyed (job_id, artifact_hash), where
-- artifact_hash is the hash of the current attendance cycle id. It borrows
-- nothing from the money kinds: no release, obligation or docket ids, no
-- route_kind, and it cannot touch the sealed money fence.
--
-- Shape invariants:
--   - job_id required
--   - artifact_hash required: the attendance-cycle coordinate, so one cycle
--     is one SMS while a genuine reattend (new cycle) may text again
--   - release / invoice-obligation / docket ids must be null
--   - route_kind must be null (this is not a builder route)
--   - unique (job_id, artifact_hash) for the kind
--
-- Writes zero operational rows. Does not send, mint, authorise, void, or
-- release. Rollback twin:
--   supabase/rollbacks/20260807120000_ses_docs_ready_sms_effect_down.sql

ALTER TABLE public.ses_external_effects
  DROP CONSTRAINT IF EXISTS ses_external_effects_effect_kind_check;
ALTER TABLE public.ses_external_effects
  ADD CONSTRAINT ses_external_effects_effect_kind_check CHECK (
    effect_kind IN (
      'invoice_create',
      'invoice_authorise',
      'invoice_void',
      'route_send',
      'document_store',
      'mailer_ops_send',
      'docs_ready_sms'
    )
  );

ALTER TABLE public.ses_external_effects
  DROP CONSTRAINT IF EXISTS ses_external_effect_shape;
ALTER TABLE public.ses_external_effects
  ADD CONSTRAINT ses_external_effect_shape CHECK (
    (effect_kind = 'invoice_create'
      AND invoice_obligation_revision_id IS NOT NULL
      AND release_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'invoice_authorise'
      AND invoice_obligation_revision_id IS NOT NULL
      AND release_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'invoice_void'
      AND job_id IS NOT NULL
      AND artifact_hash IS NOT NULL
      AND release_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'route_send'
      AND release_revision_id IS NOT NULL
      AND route_kind IS NOT NULL)
    OR (effect_kind = 'document_store'
      AND docket_revision_id IS NOT NULL
      AND artifact_hash IS NOT NULL)
    OR (effect_kind = 'mailer_ops_send'
      AND job_id IS NOT NULL
      AND route_kind IN ('report', 'photo')
      AND release_revision_id IS NULL
      AND invoice_obligation_revision_id IS NULL
      AND docket_revision_id IS NULL
      AND artifact_hash IS NOT NULL)
    OR (effect_kind = 'docs_ready_sms'
      AND job_id IS NOT NULL
      AND artifact_hash IS NOT NULL
      AND release_revision_id IS NULL
      AND invoice_obligation_revision_id IS NULL
      AND docket_revision_id IS NULL
      AND route_kind IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_docs_ready_sms
  ON public.ses_external_effects (job_id, artifact_hash)
  WHERE effect_kind = 'docs_ready_sms';
