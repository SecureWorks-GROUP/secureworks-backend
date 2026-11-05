-- Dispatch v2, Tweak 2 piece 2 (Shaun, 5 Nov 2026): the job number inside a
-- supplier's PDF.
--
-- Suppliers often reply with no job number in the email words: the number is
-- only on the PDF they attach (an order confirmation, a quote, an invoice).
-- The capture reader already keeps those files (context_email_attachments and
-- the storage bucket, the same copies Tweak 1 saves to the job). Now, when a
-- supplier email is still not matched after the text rungs, the reply scan
-- reads the text of its stored PDFs and looks for our job numbers
-- (SWF-, SWP-, SWR- and digits). Exactly one existing job found: the email is
-- matched to that job with the new rung 'pdf_job_number'. None, or more than
-- one: it is left as it was. Outlook is never called.
--
-- This migration only lets the new rung be stored: the
-- dispatch_v2_supplier_emails_rung_valid check gains 'pdf_job_number'. No row
-- changes. No backfill.
--
-- Rules and caller: supabase/functions/ops-api/dispatch_v2_reply_pdf.ts and
-- dispatch_v2_replies.ts. Contract: docs/dispatch-v2-board-contract.md
-- section 3f.2.
--
-- Rollback: supabase/rollbacks/20261105171000_dispatch_v2_reply_pdf_rung_down.sql.

ALTER TABLE public.dispatch_v2_supplier_emails
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_emails_rung_valid;
ALTER TABLE public.dispatch_v2_supplier_emails
  ADD CONSTRAINT dispatch_v2_supplier_emails_rung_valid CHECK (
    rung IS NULL OR rung IN ('thread', 'job_number', 'pdf_job_number', 'supplier_ref', 'best_guess', 'manual')
  );

COMMENT ON CONSTRAINT dispatch_v2_supplier_emails_rung_valid ON public.dispatch_v2_supplier_emails IS
  'How a supplier email was matched: thread, job_number (in the email words), pdf_job_number (in its stored PDF, Tweak 2 piece 2), supplier_ref, best_guess or manual.';
