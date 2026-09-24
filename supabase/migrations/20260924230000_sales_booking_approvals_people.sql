-- Booking approvals for each booking person (owner ruling 2026-09-24: each
-- person's booking texts go from their own number). The approvals table only
-- accepted Marnin's Stratco rows; Nithin's and Khairo's text approvals now
-- record too. Nothing else changes: the owner is still the only approver
-- (ops-api), and the snapshot must still name the same resource as the row.
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.sales_booking_approvals'::regclass
    AND c.conname = 'sales_booking_approvals_resource_check';
  IF def IS DISTINCT FROM 'CHECK ((resource = ''marnin''::text))' THEN
    RAISE EXCEPTION 'sales_booking_approvals_resource_check is not the reviewed Marnin-only check: %',
      coalesce(def, '(missing)');
  END IF;
END $$;

ALTER TABLE public.sales_booking_approvals
  DROP CONSTRAINT sales_booking_approvals_resource_check;
ALTER TABLE public.sales_booking_approvals
  ADD CONSTRAINT sales_booking_approvals_resource_check
  CHECK (resource IN ('marnin', 'nithin', 'khairo'));
