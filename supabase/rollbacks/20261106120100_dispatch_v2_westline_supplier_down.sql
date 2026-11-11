-- Down for 20261106120100_dispatch_v2_westline_supplier. Removes the Westline Fencing entry
-- that migration added, and any Xero link made to it since (the link rows cascade). Orders
-- already recorded to Westline keep their supplier; nothing else changes.
DELETE FROM public.dispatch_approved_supplier_emails
WHERE org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND name = 'Westline Fencing'
  AND approved_on = DATE '2026-11-06';
