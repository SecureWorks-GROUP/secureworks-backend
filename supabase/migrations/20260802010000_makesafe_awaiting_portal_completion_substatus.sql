-- F4 — a truthful report-only waiting state for make-safe cards.
--
-- WHY: every newly auto-approved roof / assessment (report-only) card was written
-- straight to substatus 'ready_to_invoice' at intake, and the legacy board ladder
-- reads 'ready_to_invoice' as submitted-report evidence and derives Report Ready.
-- So a report card claimed to be report-ready before anyone proved the builder's
-- Prime portal report was completed. The captain's ruling is that a report card
-- with no confirmed completion belongs in Allocated.
--
-- 'awaiting_portal_completion' means exactly what it says: the report-only card is
-- instructed and live, and it is waiting on proof that the builder-portal report
-- was completed. It is a PRE-report substatus, so
-- PORTAL_GUARDED_ADVANCE_SUBSTATUSES still guards every advance out of it, and
-- `mark_makesafe_portal_report_done` (the explicit portal-completion evidence
-- event) remains the only path that moves it to admin_to_send_report.
--
-- SCOPE / SAFETY:
--   * This migration widens a CHECK constraint. It writes ZERO rows: no UPDATE,
--     no INSERT, no DELETE, no backfill of existing cards. Existing-card cleanup
--     is a separate, captain-gated tranche.
--   * The allowed list below deliberately RETAINS 'pending_allocation'. The live
--     production constraint carries it and 11 production rows still use it, while
--     20260601000001_makesafe_job_contract.sql (the repo's defining migration)
--     does not. Dropping it would make this migration fail on apply in
--     production. Verified read-only 2026-08-02 via the Management API
--     (`pg_get_constraintdef` on makesafe_job_details_substatus_check).
--   * The constraint is RENAMED to `..._check_v2` so the edge-deploy schema gate
--     (scripts/edge-function-schema-requirements.txt) can prove by marker
--     existence that the widening actually landed before ops-api ships code that
--     writes the new value.
--   * No money or invoice state is touched. `ready_to_invoice` is a board
--     substatus only; no invoice/pack/send path selects on it.

ALTER TABLE public.makesafe_job_details
  DROP CONSTRAINT IF EXISTS makesafe_job_details_substatus_check;

ALTER TABLE public.makesafe_job_details
  DROP CONSTRAINT IF EXISTS makesafe_job_details_substatus_check_v2;

ALTER TABLE public.makesafe_job_details
  ADD CONSTRAINT makesafe_job_details_substatus_check_v2
  CHECK (substatus IN (
    'pending_allocation',
    'company_contact_required',
    'company_contact_done',
    'awaiting_portal_completion',
    'waiting_on_trade_report',
    'admin_to_send_report',
    'ready_to_invoice',
    'complete'
  ));

COMMENT ON CONSTRAINT makesafe_job_details_substatus_check_v2
  ON public.makesafe_job_details IS
  'Canonical make-safe board substatuses. awaiting_portal_completion (F4) is the report-only waiting state: instructed, not yet proved complete on the builder portal. Both board stage engines map it to Allocated. pending_allocation is retained legacy production drift.';
