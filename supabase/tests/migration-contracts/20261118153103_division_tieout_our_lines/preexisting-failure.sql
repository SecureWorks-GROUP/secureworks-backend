CREATE OR REPLACE FUNCTION public.division_tieout_our_lines(p_org_id uuid, p_month date)
RETURNS TABLE (
  document_type text,
  document_id text,
  document_number text,
  line_id text,
  account_code text,
  xero_option text,
  our_option text,
  amount_ex numeric,
  on_job boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::numeric, NULL::boolean
  WHERE false;
$$;
