-- Trade chase SMS effect (Harden SES v1, ticket 10).
--
-- The KPI is fixed: work allocated on day X means the trade's report is in
-- by 4 PM Perth the next business day. Past that, the system reminds the
-- allocated trade on the internal SMS path. The application path is DARK by
-- default (SES_TRADE_CHASE_ENABLED) and is switched on only after the
-- backlog reconcile, so this migration changes no behaviour on its own.
--
-- Adds effect_kind `trade_chase_sms`: exact-once per job per LOCAL DAY,
-- keyed (job_id, artifact_hash) where artifact_hash covers {job_id, date}.
-- Same non-money shape as docs_ready_sms: it borrows nothing from the money
-- kinds and cannot touch the sealed money fence.
--
-- Writes zero operational rows. Rollback twin:
--   supabase/rollbacks/20260807170000_ses_trade_chase_effect_down.sql

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
      'trade_chase_sms'
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_trade_chase_sms
  ON public.ses_external_effects (job_id, artifact_hash)
  WHERE effect_kind = 'trade_chase_sms';
