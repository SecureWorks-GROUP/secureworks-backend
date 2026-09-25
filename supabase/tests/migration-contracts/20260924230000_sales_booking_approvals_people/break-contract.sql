-- Put the Marnin-only check back: the contract must fail on Nithin's row.
ALTER TABLE public.sales_booking_approvals
  DROP CONSTRAINT sales_booking_approvals_resource_check;
ALTER TABLE public.sales_booking_approvals
  ADD CONSTRAINT sales_booking_approvals_resource_check CHECK (resource = 'marnin');
