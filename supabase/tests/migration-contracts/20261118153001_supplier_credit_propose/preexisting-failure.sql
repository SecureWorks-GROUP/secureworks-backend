CREATE OR REPLACE FUNCTION public.supplier_credit_matching_bills(
  p_org_id uuid,
  p_bill_number text
) RETURNS TABLE (
  xero_invoice_id text,
  invoice_number text,
  xero_contact_id text,
  contact_name text,
  job_id uuid
) LANGUAGE sql AS $drift$
  SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid WHERE false;
$drift$;
