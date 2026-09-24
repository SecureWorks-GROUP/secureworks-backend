-- Back to Marnin-only approvals. Refuses while a Nithin or Khairo approval row
-- exists, rather than deleting approval history.
ALTER TABLE public.sales_booking_approvals
  DROP CONSTRAINT sales_booking_approvals_resource_check;
ALTER TABLE public.sales_booking_approvals
  ADD CONSTRAINT sales_booking_approvals_resource_check
  CHECK (resource = 'marnin');
