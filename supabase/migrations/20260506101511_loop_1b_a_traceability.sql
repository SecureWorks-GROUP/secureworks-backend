-- Loop 1B-a traceability migration.
--
-- Applied: 2026-05-06T10:15Z via mcp__supabase__apply_migration as
--   20260506101511_loop_1b_a_traceability. This file is the canonical
--   migrations/ copy of the draft Marnin merged in PR #40 (under the
--   _drafts/ filename 20260505110000_loop_1b_traceability.sql). Renamed
--   here to match the remote ledger timestamp.
--
-- Source of truth: cio/operations/board/Finance-AI-First/finance-loop0-signoff/
--   loop-1b-a-migration-design.md
--
-- Adds ten new columns to xero_invoices so every newly-created customer
-- invoice can carry the SecureWorks job number, customer name, suburb,
-- division, account_code, tracking_option, project-fill status, plus
-- pointers to the frozen quote and scope revisions, plus the neighbour
-- discriminator. Eight columns come from the strategy doc's W2 traceability
-- set; two close H1's silent-drop bug (job_contact_id, reference_suffix).
--
-- All columns nullable. Migration is idempotent (ADD COLUMN IF NOT EXISTS).
-- No data backfill in this migration; backfill is a separate later loop.

ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS job_number                 text,
  ADD COLUMN IF NOT EXISTS customer_name              text,
  ADD COLUMN IF NOT EXISTS suburb                     text,
  ADD COLUMN IF NOT EXISTS division                   text,
  ADD COLUMN IF NOT EXISTS account_code               text,
  ADD COLUMN IF NOT EXISTS tracking_option            text,
  ADD COLUMN IF NOT EXISTS xero_project_manual_status text,
  ADD COLUMN IF NOT EXISTS quote_revision_id          uuid,
  ADD COLUMN IF NOT EXISTS scope_revision_id          uuid,
  ADD COLUMN IF NOT EXISTS job_contact_id             uuid,
  ADD COLUMN IF NOT EXISTS reference_suffix           text;

-- Foreign keys deferred. quote_revisions / scope_revisions / job_contacts
-- table readiness is owned by the Scope-Memory-Saving lane. A follow-up
-- migration can add REFERENCES clauses once that lane confirms.

-- Indexes (additive, partial WHERE NOT NULL where appropriate).
CREATE INDEX IF NOT EXISTS idx_xero_invoices_division
  ON public.xero_invoices (org_id, division, invoice_date DESC);

CREATE INDEX IF NOT EXISTS idx_xero_invoices_job_contact_id
  ON public.xero_invoices (job_contact_id) WHERE job_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_xero_invoices_quote_revision_id
  ON public.xero_invoices (quote_revision_id) WHERE quote_revision_id IS NOT NULL;

-- Column comments for the next bookkeeper-or-AI reader.
COMMENT ON COLUMN public.xero_invoices.job_number                 IS 'SecureWorks job number stamped at create-time. Mirrors jobs.job_number.';
COMMENT ON COLUMN public.xero_invoices.customer_name              IS 'Customer name as written at create-time. May differ from contact_name if Xero contact renamed post-create.';
COMMENT ON COLUMN public.xero_invoices.suburb                     IS 'Site suburb at create-time. Per Loop 1B traceability — see Finance AI-First roadmap §B.';
COMMENT ON COLUMN public.xero_invoices.division                   IS 'patio | fencing | decking | roofing | insurance | renovation | combo. Mirrors jobs.type at create-time.';
COMMENT ON COLUMN public.xero_invoices.account_code               IS 'Xero account code mirrored at the invoice-row level for fast division reporting. Source: accountCodeForJob(jobs.type).';
COMMENT ON COLUMN public.xero_invoices.tracking_option            IS 'Xero TrackingCategory option name. Source: trackingCategoryForJob(reference).';
COMMENT ON COLUMN public.xero_invoices.xero_project_manual_status IS 'not_applicable | needs_manual_fill | filled | ignored. Per Loop 1B; Xero Projects is manual-fill only — see decisions/2026-04-09-financial-reporting-architecture.md.';
COMMENT ON COLUMN public.xero_invoices.quote_revision_id          IS 'FK to quote_revisions.id (deferred). Set at create-time when the originating quote was frozen.';
COMMENT ON COLUMN public.xero_invoices.scope_revision_id          IS 'FK to scope_revisions.id (deferred). Set at create-time when the originating scope was frozen.';
COMMENT ON COLUMN public.xero_invoices.job_contact_id             IS 'FK to job_contacts.id (deferred). Distinguishes neighbour A from neighbour B on multi-neighbour jobs. Closes H1 silent-drop bug.';
COMMENT ON COLUMN public.xero_invoices.reference_suffix           IS 'Computed reference suffix at create-time (DEP50, FINBAL, REAR-A-DEP50, etc.). Closes H1 silent-drop bug.';
