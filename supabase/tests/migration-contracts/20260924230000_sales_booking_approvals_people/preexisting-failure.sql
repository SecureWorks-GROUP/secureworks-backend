-- Someone already changed the resource check by hand: the migration must
-- refuse rather than silently replace an unreviewed rule.
ALTER TABLE public.sales_booking_approvals
  DROP CONSTRAINT sales_booking_approvals_resource_check;
ALTER TABLE public.sales_booking_approvals
  ADD CONSTRAINT sales_booking_approvals_resource_check CHECK (resource <> '');
