-- Dispatch v2 Tweak 4: a simpler supplier picker (Shaun said Go on 5 Nov 2026).
--
-- Contract: docs/dispatch-v2-emails-contract.md, section "Tweak 4". Rules:
-- supabase/functions/ops-api/dispatch_v2_supplier_picker.ts. Reader:
-- ops-api dispatch_v2_supplier_search (dispatch_v2_store.ts).
--
-- What this does, in business words:
--   1. A pin. Each approved supplier may name one of its linked Xero contacts
--      as its "main" contact by hand (pinned_supplier_id). The Add supplier
--      search otherwise picks the linked contact with the most Xero bills in
--      the last 12 months. A pin always wins while the contact is linked.
--   2. The bill counts, worked out by Postgres on every read: the view
--      dispatch_approved_supplier_contact_bills gives, for each linked Xero
--      contact, its bills (ACCPAY, not DELETED, not VOIDED) dated in the last
--      12 months (Perth date), the date of its newest bill, and whether it is
--      the pinned one. Read on demand rather than kept in a table refreshed
--      each day: it is always as fresh as the 06:55 Xero sync, needs no cron,
--      and reads in about 5 ms today (44 links, one indexed look-up each on
--      xero_invoices.xero_contact_id).
--   3. Shaun's answers on the design page, 5 Nov 2026:
--        - "B&D Metals Group" is renamed "BD Metals", and "R&R Fencing" is
--          renamed "RnR Fencing" (the approved name is the name Dispatch
--          shows). The order email body never names the supplier, so the
--          suppliers see no change.
--        - Ampelite: the CC warwick@ampelite.com.au is removed. To stays
--          waorders@ampelite.com.au, and Ampelite stays pay first.
--        - CMI: pinned to the Xero contact "CMI (Combined Metal Industries /
--          CMI WA)" (id cad56667-fb78-4232-948e-0d6457d9626f, read only on
--          5 Nov 2026). CMI moved contact in October: the newest bills land
--          there, though the Trustee contact has more over the year.
--
-- Every data change matches by organisation, the name as stored and (for the
-- pin) a contact that is really linked, so on a copy of the database where a
-- row is missing it simply matches nothing. Nothing here touches suppliers
-- (the 06:55 Xero sync owns it), xero_invoices, jobs, purchase orders, Xero,
-- GHL, SMS or email.
--
-- Rollback: supabase/rollbacks/20261105184500_dispatch_v2_supplier_picker_down.sql.

-- 1. The pin.
ALTER TABLE public.dispatch_approved_supplier_emails
  ADD COLUMN IF NOT EXISTS pinned_supplier_id uuid NULL
    REFERENCES public.suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pinned_by text NULL,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz NULL;

COMMENT ON COLUMN public.dispatch_approved_supplier_emails.pinned_supplier_id IS
  'Dispatch v2 Tweak 4: the linked Xero contact (suppliers.id) a person chose as this supplier''s main contact. The Add supplier search puts the box on it. NULL = the linked contact with the most Xero bills in the last 12 months. A pin to a contact that is no longer linked is ignored.';
COMMENT ON COLUMN public.dispatch_approved_supplier_emails.pinned_by IS
  'Dispatch v2 Tweak 4: who set the pin (a name or email), for the record.';
COMMENT ON COLUMN public.dispatch_approved_supplier_emails.pinned_at IS
  'Dispatch v2 Tweak 4: when the pin was set.';

-- 2. The bill counts per linked Xero contact. security_invoker: it reads with
-- the caller's rights, and only service_role (ops-api) may read it.
CREATE OR REPLACE VIEW public.dispatch_approved_supplier_contact_bills
WITH (security_invoker = true) AS
SELECT
  l.org_id,
  l.approved_id,
  l.supplier_id,
  COALESCE(b.bills_12m, 0)::integer AS bills_12m,
  b.last_bill_date,
  (e.pinned_supplier_id IS NOT NULL AND e.pinned_supplier_id = l.supplier_id) AS is_pinned
FROM public.dispatch_approved_supplier_email_links l
JOIN public.dispatch_approved_supplier_emails e ON e.id = l.approved_id
JOIN public.suppliers s ON s.id = l.supplier_id
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (
      WHERE i.invoice_date >= ((now() AT TIME ZONE 'Australia/Perth')::date - interval '12 months')
    ) AS bills_12m,
    max(i.invoice_date) AS last_bill_date
  FROM public.xero_invoices i
  WHERE s.xero_contact_id IS NOT NULL
    AND i.xero_contact_id = s.xero_contact_id
    AND i.org_id = s.org_id
    AND i.invoice_type = 'ACCPAY'
    AND COALESCE(i.status, '') NOT IN ('DELETED', 'VOIDED')
) b ON true;

COMMENT ON VIEW public.dispatch_approved_supplier_contact_bills IS
  'Dispatch v2 Tweak 4: for each Xero contact linked to an approved supplier, its Xero bills (ACCPAY, not DELETED or VOIDED) dated in the last 12 months (Perth date), its newest bill date, and whether it is the pinned main contact. Worked out on every read. Read by ops-api dispatch_v2_supplier_search only.';

REVOKE ALL ON TABLE public.dispatch_approved_supplier_contact_bills FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.dispatch_approved_supplier_contact_bills TO service_role;

-- 3a. The renames (Shaun, 5 Nov 2026). Skipped when the new name is already
-- taken, so the unique (org_id, name) key never fails.
UPDATE public.dispatch_approved_supplier_emails e
SET name = 'BD Metals', updated_at = now()
WHERE e.org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND e.name = 'B&D Metals Group'
  AND NOT EXISTS (
    SELECT 1 FROM public.dispatch_approved_supplier_emails x
    WHERE x.org_id = e.org_id AND x.name = 'BD Metals'
  );

UPDATE public.dispatch_approved_supplier_emails e
SET name = 'RnR Fencing', updated_at = now()
WHERE e.org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND e.name = 'R&R Fencing'
  AND NOT EXISTS (
    SELECT 1 FROM public.dispatch_approved_supplier_emails x
    WHERE x.org_id = e.org_id AND x.name = 'RnR Fencing'
  );

-- 3b. Ampelite: no supplier CC. To stays as it is; on_account is not touched.
UPDATE public.dispatch_approved_supplier_emails
SET cc_emails = array_remove(cc_emails, 'warwick@ampelite.com.au'),
    updated_at = now()
WHERE org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND name = 'Ampelite'
  AND 'warwick@ampelite.com.au' = ANY (cc_emails);

-- 3c. The CMI pin, only when that contact really is linked to CMI.
UPDATE public.dispatch_approved_supplier_emails e
SET pinned_supplier_id = 'cad56667-fb78-4232-948e-0d6457d9626f'::uuid,
    pinned_by = 'Shaun',
    pinned_at = now(),
    updated_at = now()
WHERE e.org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND e.name = 'CMI (Combined Metal Industries)'
  AND e.pinned_supplier_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.dispatch_approved_supplier_email_links l
    WHERE l.approved_id = e.id
      AND l.supplier_id = 'cad56667-fb78-4232-948e-0d6457d9626f'::uuid
  );
