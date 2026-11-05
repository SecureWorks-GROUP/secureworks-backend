-- Dispatch v2, Tweak 1 (Shaun, 4 Nov 2026): the supplier's documents saved to
-- the job once an order is confirmed. One table.
--
-- When a supplier order is confirmed (Accept on a reply's date, or a box moved
-- to Order confirmed by hand), ops-api copies every PDF on the supplier
-- replies matched to that order into the job's documents (job_documents type
-- 'material_order', visible to the crew), named for what it is: "Stratco
-- order confirmation", "B&D invoice", "R&R quote". The reply scan sweeps
-- confirmed orders every five minutes for later PDFs (a later invoice). When
-- no matched reply carries a PDF, it saves our own one-page "Material order"
-- sheet instead (source 'order_sheet').
--
-- This table is the once-only memory: one row per file per job, by the file's
-- SHA-256, so the same PDF is never saved twice however many replies carry it
-- or however often the sweep runs. A row is 'claimed' while it is being saved
-- and 'saved' once the job_documents row exists. A claim older than ten
-- minutes was left by a run that died and may be taken over.
--
-- The PDFs come from the email capture reader's private bucket
-- (context-email-attachments, ledger context_email_attachments). Nothing here
-- calls Outlook.
--
-- Rules and writer: supabase/functions/ops-api/dispatch_v2_order_documents.ts.
-- Contract: docs/dispatch-v2-board-contract.md section 3e.2. Only ops-api
-- writes this table. Row security on with no policy, revoked from the browser
-- roles, as the other dispatch_v2_* tables are.
--
-- No job, job status, supplier (suppliers is never written), Xero, GHL, send
-- or existing row is touched by this migration. No backfill.
--
-- Rollback: supabase/rollbacks/20261105161000_dispatch_v2_order_documents_down.sql.

CREATE TABLE IF NOT EXISTS public.dispatch_v2_order_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- The supplier order email (dispatch_supplier_order_emails.id).
  order_id uuid NOT NULL
    REFERENCES public.dispatch_supplier_order_emails(id) ON DELETE CASCADE,
  supplier_id uuid NULL,
  -- 'supplier_reply' = a PDF from a matched reply; 'order_sheet' = our own
  -- Material order sheet, made when no matched reply had a PDF.
  source text NOT NULL,
  kind text NOT NULL,
  content_sha256 text NOT NULL,
  reply_email_id uuid NULL,
  attachment_id uuid NULL,
  source_file_name text NULL,
  state text NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  saved_at timestamptz NULL,
  job_document_id uuid NULL REFERENCES public.job_documents(id) ON DELETE SET NULL,
  storage_path text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_order_documents_job_file_unique UNIQUE (job_id, content_sha256),
  CONSTRAINT dispatch_v2_order_documents_source_valid CHECK (
    source IN ('supplier_reply', 'order_sheet')
  ),
  CONSTRAINT dispatch_v2_order_documents_kind_valid CHECK (
    kind IN ('order_confirmation', 'invoice', 'quote', 'order_document', 'order_sheet')
  ),
  CONSTRAINT dispatch_v2_order_documents_state_valid CHECK (
    state IN ('claimed', 'saved')
  ),
  CONSTRAINT dispatch_v2_order_documents_sha_valid CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT dispatch_v2_order_documents_saved_has_document CHECK (
    state <> 'saved' OR (job_document_id IS NOT NULL AND saved_at IS NOT NULL)
  )
);

-- One order sheet per order at most.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_v2_order_documents_one_sheet
  ON public.dispatch_v2_order_documents (order_id)
  WHERE source = 'order_sheet';
CREATE INDEX IF NOT EXISTS dispatch_v2_order_documents_order_idx
  ON public.dispatch_v2_order_documents (order_id);

COMMENT ON TABLE public.dispatch_v2_order_documents IS
  'Dispatch v2 Tweak 1: each supplier PDF (or our own order sheet) saved to a job''s documents once an order is confirmed. One row per file per job (unique job_id, content_sha256), so a file is saved once.';
COMMENT ON COLUMN public.dispatch_v2_order_documents.state IS
  'claimed while being saved; saved once the job_documents row exists. A claim older than ten minutes may be taken over.';

ALTER TABLE public.dispatch_v2_order_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_v2_order_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_v2_order_documents TO service_role;
