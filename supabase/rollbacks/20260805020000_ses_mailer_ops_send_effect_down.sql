-- Rollback: remove mailer_ops_send effect kind.
-- Refuses if any mailer_ops_send rows exist (preserve ledger integrity).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ses_external_effects
    WHERE effect_kind = 'mailer_ops_send'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'cannot drop mailer_ops_send: ses_external_effects rows still exist';
  END IF;
END $$;

DROP INDEX IF EXISTS public.uq_ses_external_mailer_ops_send;

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
  );

ALTER TABLE public.ses_external_effects
  DROP CONSTRAINT IF EXISTS ses_external_effects_effect_kind_check;
ALTER TABLE public.ses_external_effects
  ADD CONSTRAINT ses_external_effects_effect_kind_check CHECK (
    effect_kind IN (
      'invoice_create',
      'invoice_authorise',
      'invoice_void',
      'route_send',
      'document_store'
    )
  );
