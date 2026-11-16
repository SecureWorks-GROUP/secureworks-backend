-- Remove the promised behaviour: a holding job becomes a candidate, so the contract's holding job
-- check must fail.
CREATE OR REPLACE FUNCTION public.context_job_evidence_for_bills(p_bill_ids text[], p_blind boolean DEFAULT false)
RETURNS TABLE(xero_invoice_id text, invoice_number text, decision text, job_id uuid, job_number text, reason text,
              strong jsonb, weak jsonb, notes jsonb, policy text)
LANGUAGE sql STABLE AS $fn$
 SELECT a.id, x.invoice_number, 'named', j.id, j.job_number, 'most_strong_evidence', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        'job-evidence-v1'
 FROM unnest(p_bill_ids) a(id)
 JOIN public.xero_invoices x ON x.xero_invoice_id = a.id
 JOIN public.jobs j ON upper(x.reference) LIKE '%' || upper(j.job_number) || '%'
$fn$;
