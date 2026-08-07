-- Rollback twin for 20260807150000_ses_invoice_create_retry_attempt.sql.
-- Restores the single-row-per-obligation-revision index. Any retry rows
-- (artifact_hash NOT NULL, effect_kind invoice_create) must be resolved and
-- removed first or the narrower unique index creation fails.

DROP INDEX IF EXISTS public.uq_ses_external_invoice_create;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_invoice_create
  ON public.ses_external_effects (invoice_obligation_revision_id)
  WHERE effect_kind = 'invoice_create';
