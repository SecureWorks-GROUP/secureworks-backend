-- SES mailer ops-visibility send effect (ops-only ordinary Mail.Send).
--
-- Captain 2026-08-05: eight authorised ops emails to the builder WORK-ORDER
-- mailer (report PDF + capped photos). There is no sanctioned transport today:
-- send-outlook-email correctly refuses sealed SES (pdf_provenance_required /
-- sealed_ses_release_required), and execute_ses_release_revision is the
-- billing pack path (out of scope for mailer ops visibility).
--
-- This migration adds effect_kind `mailer_ops_send` so the new ops-api action
-- can claim an exact-once ledger row with Sent Items proof, WITHOUT borrowing
-- a release_revision_id (route_send requires one) and WITHOUT weakening the
-- sealed money fence or the legacy Outlook path.
--
-- Shape invariants:
--   - job_id required
--   - route_kind is report|photo only (invoice is structurally impossible)
--   - release / invoice-obligation / docket ids must be null
--   - artifact_hash required: it is the retry coordinate (a content address of
--     the exact send plus the operator's attempt key) that route_send gets from
--     release_revision_id. Without it one Graph failure would park a card on a
--     stuck `unknown` row forever, since a token is never redispatched.
--   - unique (job_id, route_kind, artifact_hash) so one exact send attempt is
--     one ledger row per kind per card, while a deliberate new attempt can run
--
-- Writes zero operational rows. Does not send, mint, authorise, void, or
-- release. Rollback twin:
--   supabase/rollbacks/20260805020000_ses_mailer_ops_send_effect_down.sql

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
      'mailer_ops_send'
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_mailer_ops_send
  ON public.ses_external_effects (job_id, route_kind, artifact_hash)
  WHERE effect_kind = 'mailer_ops_send';
