-- Rollback twin for 20260807120000_ses_docs_ready_sms_effect.sql.
-- Restores the effect-kind and shape constraints to their 20260805020000
-- state and drops the docs_ready_sms unique index. Any existing
-- docs_ready_sms rows must be deleted first or the restored CHECK fails.

DROP INDEX IF EXISTS public.uq_ses_external_docs_ready_sms;

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
