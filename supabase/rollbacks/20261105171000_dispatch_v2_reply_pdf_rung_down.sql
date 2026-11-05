-- Down for 20261105171000_dispatch_v2_reply_pdf_rung. Roll back ops-api first
-- (dispatch_v2_replies.ts writes the new rung).
--
-- An email already matched by the job number in its PDF stays matched to the
-- same job and order: its rung reads 'job_number' (the nearest older rung), so
-- the old check holds. Nothing else changes.
UPDATE public.dispatch_v2_supplier_emails
   SET rung = 'job_number'
 WHERE rung = 'pdf_job_number';
ALTER TABLE public.dispatch_v2_supplier_emails
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_emails_rung_valid;
ALTER TABLE public.dispatch_v2_supplier_emails
  ADD CONSTRAINT dispatch_v2_supplier_emails_rung_valid CHECK (
    rung IS NULL OR rung IN ('thread', 'job_number', 'supplier_ref', 'best_guess', 'manual')
  );
