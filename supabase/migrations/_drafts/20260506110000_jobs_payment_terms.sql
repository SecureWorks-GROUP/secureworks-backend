-- Loop 1B-a-apply: per-job payment terms override (DRAFT — not yet applied).
--
-- Apply gate: separate from this PR. Requires explicit Marnin approval phrase.
-- Source of truth: cio/operations/board/Finance-AI-First/finance-loop0-signoff/
--   four-pillars-progress-2026-05-06.md §5.1 (decision item 2).
--
-- Adds an optional payment_terms text column to jobs so an operator (or a
-- per-customer policy in a future loop) can override the SecureWorks default
-- of "Net 14 days" for a specific job. The text appears verbatim in the Xero
-- invoice's Terms field. When NULL, createInvoice falls back to a sensible
-- division-aware default (see ops-api/index.ts:buildXeroInvoiceTerms).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). NULL-able. No data backfill.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS payment_terms text;

COMMENT ON COLUMN public.jobs.payment_terms IS
  'Per-job payment-terms text appended to Xero invoices created from this job. '
  'When NULL, createInvoice uses pricing_json.payment_terms or a division default. '
  'See cio/operations/board/Finance-AI-First/finance-loop0-signoff/four-pillars-progress-2026-05-06.md.';
