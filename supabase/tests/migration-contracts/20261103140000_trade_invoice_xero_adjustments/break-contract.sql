-- Drop the tie: a total that its named lines do not explain must then get
-- through, and the contract must catch it.
ALTER TABLE public.trade_invoices
  DROP CONSTRAINT trade_invoices_xero_adjustments_read_together;
