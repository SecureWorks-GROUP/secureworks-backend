-- Down for 20261105184500_dispatch_v2_supplier_picker. Roll ops-api back first: the
-- dispatch_v2_supplier_search read selects the view dispatch_approved_supplier_contact_bills
-- (a failed read only drops the bill ranking, but the deploy check names the view).
--
-- Puts back what the migration changed: drops the bill count view and the pin columns,
-- renames "BD Metals" back to "B&D Metals Group" and "RnR Fencing" back to "R&R Fencing"
-- (only when the old name is free), and puts warwick@ampelite.com.au back on Ampelite's CC.
-- Every approved supplier entry and link stays. suppliers is never touched.

DROP VIEW IF EXISTS public.dispatch_approved_supplier_contact_bills;

ALTER TABLE public.dispatch_approved_supplier_emails
  DROP COLUMN IF EXISTS pinned_at,
  DROP COLUMN IF EXISTS pinned_by,
  DROP COLUMN IF EXISTS pinned_supplier_id;

UPDATE public.dispatch_approved_supplier_emails e
SET name = 'B&D Metals Group', updated_at = now()
WHERE e.org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND e.name = 'BD Metals'
  AND NOT EXISTS (
    SELECT 1 FROM public.dispatch_approved_supplier_emails x
    WHERE x.org_id = e.org_id AND x.name = 'B&D Metals Group'
  );

UPDATE public.dispatch_approved_supplier_emails e
SET name = 'R&R Fencing', updated_at = now()
WHERE e.org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND e.name = 'RnR Fencing'
  AND NOT EXISTS (
    SELECT 1 FROM public.dispatch_approved_supplier_emails x
    WHERE x.org_id = e.org_id AND x.name = 'R&R Fencing'
  );

UPDATE public.dispatch_approved_supplier_emails
SET cc_emails = array_append(cc_emails, 'warwick@ampelite.com.au'),
    updated_at = now()
WHERE org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND name = 'Ampelite'
  AND NOT ('warwick@ampelite.com.au' = ANY (cc_emails));
