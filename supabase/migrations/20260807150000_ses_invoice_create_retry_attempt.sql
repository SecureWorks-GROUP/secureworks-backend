-- invoice_create deliberate retry coordinate (Harden SES, backend issue #644).
--
-- Live wedge 2026-08-07 (SWMS-261116 / MLB-27387): create_ses_invoice_draft
-- dispatched, Xero's outcome stayed unprovable, the effect parked at
-- `unknown` — and because invoice_create's operation_key derives solely from
-- the obligation revision id (which is content-hash bit-stable), every retry
-- returns the same refusal forever. mailer_ops_send solved this exact class
-- with a deliberate attempt coordinate in artifact_hash (20260805020000).
--
-- This migration gives invoice_create the same shape: the per-kind unique
-- index widens from (invoice_obligation_revision_id) to
-- (invoice_obligation_revision_id, artifact_hash) NULLS NOT DISTINCT, so:
--   - the default mint (artifact_hash NULL) keeps exactly one row per
--     obligation revision, bit-identical operation keys, zero behavior change;
--   - a DELIBERATE retry (artifact_hash = sha256 of the caller's attempt key)
--     may claim ONE new row per attempt key. The application gate only allows
--     it when every prior attempt is unknown/failed with no external_id and
--     a live Xero reconcile by each stored token finds nothing — and the
--     unskippable live ACCREC duplicate scan still runs first, so duplicate
--     money remains impossible.
--
-- Writes zero operational rows. Rollback twin:
--   supabase/rollbacks/20260807150000_ses_invoice_create_retry_attempt_down.sql

DROP INDEX IF EXISTS public.uq_ses_external_invoice_create;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_invoice_create
  ON public.ses_external_effects (invoice_obligation_revision_id, artifact_hash)
  NULLS NOT DISTINCT
  WHERE effect_kind = 'invoice_create';
