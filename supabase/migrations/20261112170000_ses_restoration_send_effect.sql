-- Restoration document send effect (owner, 12 Nov 2026).
--
-- A restoration card's AUTHORISED invoice and its quote go to the builder's
-- restoration contact (makesafe_companies.restoration_recipients), not through
-- the make-safe release graph. ops-api send_restoration_document is that route:
-- restoration cards only, one named document per call, admin@ Mail.Send with
-- ses@ copied, Sent Items proof by operation header.
--
-- Adds effect_kind `restoration_send`, keyed (job_id, artifact_hash) where the
-- artifact hash covers kind, document identity, recipients and the operator's
-- attempt key. Same non-money shape as trade_chase_sms. Writes zero rows.
-- Rollback twin: supabase/rollbacks/20261112170000_ses_restoration_send_effect_down.sql

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
      'docs_ready_sms',
      'trade_chase_sms',
      'restoration_send'
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
    OR (effect_kind = 'trade_chase_sms'
      AND job_id IS NOT NULL
      AND artifact_hash IS NOT NULL
      AND release_revision_id IS NULL
      AND invoice_obligation_revision_id IS NULL
      AND docket_revision_id IS NULL
      AND route_kind IS NULL)
    OR (effect_kind = 'restoration_send'
      AND job_id IS NOT NULL
      AND artifact_hash IS NOT NULL
      AND release_revision_id IS NULL
      AND invoice_obligation_revision_id IS NULL
      AND docket_revision_id IS NULL
      AND route_kind IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_restoration_send
  ON public.ses_external_effects (job_id, artifact_hash)
  WHERE effect_kind = 'restoration_send';
