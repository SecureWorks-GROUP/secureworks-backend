-- Put back the reading the second review caught: every invoice that is not
-- ops-reject counts as paid, drafts included. The contract must catch that
-- an unbilled draft is taken off the pot and its owner left out of the crew.
CREATE OR REPLACE FUNCTION public.group_work_order_invoice_billed(
  p_status text,
  p_xero_bill_id text,
  p_xero_bill_status text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_status IS DISTINCT FROM 'ops-reject';
$$;
