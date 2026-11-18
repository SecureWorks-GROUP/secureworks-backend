-- P3-03.1. The invoice-line placement predicate below is copied from
-- 20261103200000_job_revenue_follows_ledger_evidence.sql, lines 44-46.
-- A current invoice line on a job keeps its invoice off the no-job list.
CREATE OR REPLACE FUNCTION public.customer_invoices_on_no_job(
  p_org_id uuid, p_as_of date, p_from date DEFAULT '2026-07-01'
) RETURNS TABLE (
  xero_invoice_id text, invoice_number text, contact_name text, invoice_date date,
  status text, total numeric, age_days integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $read$
  SELECT x.xero_invoice_id, x.invoice_number, x.contact_name, x.invoice_date,
         x.status, x.total, p_as_of - x.invoice_date
  FROM public.xero_invoices x
  WHERE x.org_id = p_org_id
    AND x.invoice_type = 'ACCREC'
    AND x.job_id IS NULL
    AND x.status IN ('AUTHORISED', 'SUBMITTED', 'PAID')
    AND x.invoice_date BETWEEN p_from AND p_as_of
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END
      ) li(value)
      JOIN public.v_bookkeeping_line_evidence_current ev
        ON x.job_id IS NULL AND ev.xero_invoice_id = x.xero_invoice_id
       AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text)
       AND ev.allocation = 'job'::text AND ev.evidenced AND ev.job_id IS NOT NULL
    )
  ORDER BY x.invoice_date, x.xero_invoice_id COLLATE "C"
$read$;

REVOKE ALL ON FUNCTION public.customer_invoices_on_no_job(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_invoices_on_no_job(uuid, date, date) TO service_role;

INSERT INTO public.feature_flags(flag_name, enabled, description)
VALUES ('customer_invoice_no_job_items_v1', false, 'Raise reconcile items for customer invoices on no job.')
ON CONFLICT (flag_name) DO NOTHING;
