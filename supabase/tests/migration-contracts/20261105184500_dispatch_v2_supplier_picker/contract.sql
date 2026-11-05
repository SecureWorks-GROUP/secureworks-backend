-- Contract for 20261105184500_dispatch_v2_supplier_picker (Dispatch v2 Tweak 4, the simpler supplier picker).
-- Proves, against the real migration on the registered stack:
--   1. the pin columns exist on dispatch_approved_supplier_emails, and a pin clears when its contact goes;
--   2. the one-off data changes landed in SecureWorks Group's organisation only: "B&D Metals Group" is now
--      "BD Metals", "R&R Fencing" is now "RnR Fencing", Ampelite has no warwick@ CC (To and the other CC stay),
--      and CMI is pinned to the CMI WA contact;
--   3. the bill count view counts, for each linked contact, only its Xero bills (ACCPAY), not DELETED, not
--      VOIDED, of its own organisation, dated in the last 12 months (Perth date); gives the newest bill date of
--      any age; and marks the pinned contact;
--   4. only service_role may read the view, and it reads with the caller's rights (security_invoker).
-- Fixture ids start 7e4a; everything written here is rolled back.

\set ON_ERROR_STOP on

-- 1. The pin columns.
DO $$
DECLARE missing text[];
BEGIN
  SELECT array_agg(c) INTO missing
  FROM unnest(ARRAY['pinned_supplier_id', 'pinned_by', 'pinned_at']) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dispatch_approved_supplier_emails' AND column_name = c
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Tweak 4: pin columns missing: %', array_to_string(missing, ', ');
  END IF;
END $$;

-- 2. The one-off data changes (rows seeded by setup.sql before the migration ran).
DO $$
DECLARE r record;
BEGIN
  SELECT name INTO r FROM public.dispatch_approved_supplier_emails WHERE id = '7e4a0000-0000-4000-8000-000000000011';
  IF r.name IS DISTINCT FROM 'BD Metals' THEN
    RAISE EXCEPTION 'Tweak 4: B&D Metals Group was not renamed BD Metals (got %)', r.name;
  END IF;
  SELECT name INTO r FROM public.dispatch_approved_supplier_emails WHERE id = '7e4a0000-0000-4000-8000-000000000012';
  IF r.name IS DISTINCT FROM 'RnR Fencing' THEN
    RAISE EXCEPTION 'Tweak 4: R&R Fencing was not renamed RnR Fencing (got %)', r.name;
  END IF;
  SELECT name INTO r FROM public.dispatch_approved_supplier_emails WHERE id = '7e4a0000-0000-4000-8000-000000000015';
  IF r.name IS DISTINCT FROM 'R&R Fencing' THEN
    RAISE EXCEPTION 'Tweak 4: the rename reached another organisation (got %)', r.name;
  END IF;

  SELECT to_emails, cc_emails INTO r FROM public.dispatch_approved_supplier_emails
  WHERE id = '7e4a0000-0000-4000-8000-000000000013';
  IF r.to_emails IS DISTINCT FROM ARRAY['waorders@ampelite.com.au']::text[] THEN
    RAISE EXCEPTION 'Tweak 4: Ampelite To changed (got %)', r.to_emails;
  END IF;
  IF r.cc_emails IS DISTINCT FROM ARRAY['tw4-keep@ampelite.example.test']::text[] THEN
    RAISE EXCEPTION 'Tweak 4: Ampelite CC should lose warwick@ only (got %)', r.cc_emails;
  END IF;

  SELECT pinned_supplier_id, pinned_by, pinned_at INTO r FROM public.dispatch_approved_supplier_emails
  WHERE id = '7e4a0000-0000-4000-8000-000000000014';
  IF r.pinned_supplier_id IS DISTINCT FROM 'cad56667-fb78-4232-948e-0d6457d9626f'::uuid
     OR r.pinned_by IS DISTINCT FROM 'Shaun' OR r.pinned_at IS NULL THEN
    RAISE EXCEPTION 'Tweak 4: CMI is not pinned to the CMI WA contact (got %, %, %)',
      r.pinned_supplier_id, r.pinned_by, r.pinned_at;
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_approved_supplier_emails
             WHERE id IN ('7e4a0000-0000-4000-8000-000000000011', '7e4a0000-0000-4000-8000-000000000012',
                          '7e4a0000-0000-4000-8000-000000000013', '7e4a0000-0000-4000-8000-000000000015')
               AND pinned_supplier_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Tweak 4: only CMI may be pinned by the migration';
  END IF;
END $$;

-- The seeded CMI rows through the view: the pinned contact is marked, the other is not.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_approved_supplier_contact_bills
                 WHERE supplier_id = 'cad56667-fb78-4232-948e-0d6457d9626f' AND is_pinned) THEN
    RAISE EXCEPTION 'Tweak 4: the view does not mark the CMI WA contact as pinned';
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_approved_supplier_contact_bills
             WHERE supplier_id = '7e4a0000-0000-4000-8000-000000000005' AND is_pinned) THEN
    RAISE EXCEPTION 'Tweak 4: the view marks an unpinned CMI contact as pinned';
  END IF;
END $$;

-- 3. The bill counts.
BEGIN;

INSERT INTO public.suppliers (id, name, org_id, is_active, xero_contact_id) VALUES
  ('7e4a0000-0000-4000-8000-000000000031', 'Tweak4 View Busy Contact', '00000000-0000-0000-0000-000000000001', true, 'tw4-xc-view-a'),
  ('7e4a0000-0000-4000-8000-000000000032', 'Tweak4 View Pinned Contact', '00000000-0000-0000-0000-000000000001', true, 'tw4-xc-view-b'),
  ('7e4a0000-0000-4000-8000-000000000033', 'Tweak4 View Hand Made Contact', '00000000-0000-0000-0000-000000000001', true, NULL),
  ('7e4a0000-0000-4000-8000-000000000034', 'Tweak4 View Old Contact', '00000000-0000-0000-0000-000000000001', true, 'tw4-xc-view-d');

INSERT INTO public.dispatch_approved_supplier_emails (id, org_id, name, to_emails) VALUES
  ('7e4a0000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000001', 'Tweak4 View Supplier',
   ARRAY['tw4-orders@view.example.test']);

INSERT INTO public.dispatch_approved_supplier_email_links (supplier_id, approved_id, org_id) VALUES
  ('7e4a0000-0000-4000-8000-000000000031', '7e4a0000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000001'),
  ('7e4a0000-0000-4000-8000-000000000032', '7e4a0000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000001'),
  ('7e4a0000-0000-4000-8000-000000000033', '7e4a0000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000001'),
  ('7e4a0000-0000-4000-8000-000000000034', '7e4a0000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000001');

UPDATE public.dispatch_approved_supplier_emails
SET pinned_supplier_id = '7e4a0000-0000-4000-8000-000000000032'
WHERE id = '7e4a0000-0000-4000-8000-000000000021';

-- Dates are relative to the Perth date the view itself uses, so the contract never ages out.
WITH perth AS (SELECT (now() AT TIME ZONE 'Australia/Perth')::date AS today)
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, invoice_number, status, xero_contact_id, invoice_date)
SELECT v.org_id::uuid, v.xid, v.itype, v.xid, v.status, v.contact, perth.today - v.days_ago
FROM perth, (VALUES
  -- Busy contact: three bills that count (PAID, AUTHORISED, DRAFT) ...
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-a1', 'ACCPAY', 'PAID',       'tw4-xc-view-a', 10),
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-a2', 'ACCPAY', 'AUTHORISED', 'tw4-xc-view-a', 40),
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-a3', 'ACCPAY', 'DRAFT',      'tw4-xc-view-a', 200),
  -- ... and five that do not: older than 12 months, deleted, voided, a sales invoice, another organisation.
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-a4', 'ACCPAY', 'PAID',       'tw4-xc-view-a', 400),
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-a5', 'ACCPAY', 'DELETED',    'tw4-xc-view-a', 5),
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-a6', 'ACCPAY', 'VOIDED',     'tw4-xc-view-a', 5),
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-a7', 'ACCREC', 'PAID',       'tw4-xc-view-a', 5),
  ('7e4a0000-0000-4000-8000-000000000099', 'tw4-inv-a8', 'ACCPAY', 'PAID',       'tw4-xc-view-a', 5),
  -- Pinned contact: one bill.
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-b1', 'ACCPAY', 'PAID',       'tw4-xc-view-b', 20),
  -- Old contact: only a bill older than 12 months.
  ('00000000-0000-0000-0000-000000000001', 'tw4-inv-d1', 'ACCPAY', 'PAID',       'tw4-xc-view-d', 500)
) AS v(org_id, xid, itype, status, contact, days_ago);

DO $$
DECLARE
  r record;
  today date := (now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
  IF (SELECT count(*) FROM public.dispatch_approved_supplier_contact_bills
      WHERE approved_id = '7e4a0000-0000-4000-8000-000000000021') <> 4 THEN
    RAISE EXCEPTION 'Tweak 4: the view must give one row per linked contact';
  END IF;

  SELECT * INTO r FROM public.dispatch_approved_supplier_contact_bills
  WHERE supplier_id = '7e4a0000-0000-4000-8000-000000000031';
  IF r.bills_12m <> 3 OR r.last_bill_date IS DISTINCT FROM today - 10 OR r.is_pinned
     OR r.org_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Tweak 4: busy contact wrong: bills %, last %, pinned %', r.bills_12m, r.last_bill_date, r.is_pinned;
  END IF;

  SELECT * INTO r FROM public.dispatch_approved_supplier_contact_bills
  WHERE supplier_id = '7e4a0000-0000-4000-8000-000000000032';
  IF r.bills_12m <> 1 OR r.last_bill_date IS DISTINCT FROM today - 20 OR NOT r.is_pinned THEN
    RAISE EXCEPTION 'Tweak 4: pinned contact wrong: bills %, last %, pinned %', r.bills_12m, r.last_bill_date, r.is_pinned;
  END IF;

  SELECT * INTO r FROM public.dispatch_approved_supplier_contact_bills
  WHERE supplier_id = '7e4a0000-0000-4000-8000-000000000033';
  IF r.bills_12m <> 0 OR r.last_bill_date IS NOT NULL OR r.is_pinned THEN
    RAISE EXCEPTION 'Tweak 4: a contact Xero does not know must show no bills: bills %, last %', r.bills_12m, r.last_bill_date;
  END IF;

  SELECT * INTO r FROM public.dispatch_approved_supplier_contact_bills
  WHERE supplier_id = '7e4a0000-0000-4000-8000-000000000034';
  IF r.bills_12m <> 0 OR r.last_bill_date IS DISTINCT FROM today - 500 THEN
    RAISE EXCEPTION 'Tweak 4: an old bill must not count but must date the newest bill: bills %, last %', r.bills_12m, r.last_bill_date;
  END IF;
END $$;

-- A pin to a contact that is deleted clears (ON DELETE SET NULL), so the bill ranking takes over again.
DELETE FROM public.dispatch_approved_supplier_email_links WHERE supplier_id = '7e4a0000-0000-4000-8000-000000000032';
DELETE FROM public.suppliers WHERE id = '7e4a0000-0000-4000-8000-000000000032';
DO $$
BEGIN
  IF (SELECT pinned_supplier_id FROM public.dispatch_approved_supplier_emails
      WHERE id = '7e4a0000-0000-4000-8000-000000000021') IS NOT NULL THEN
    RAISE EXCEPTION 'Tweak 4: a pin to a deleted contact must clear';
  END IF;
END $$;

ROLLBACK;

-- 4. Who may read the view.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.dispatch_approved_supplier_contact_bills', 'SELECT')
     OR has_table_privilege('authenticated', 'public.dispatch_approved_supplier_contact_bills', 'SELECT') THEN
    RAISE EXCEPTION 'Tweak 4: anon and authenticated must not read the bill count view';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.dispatch_approved_supplier_contact_bills', 'SELECT') THEN
    RAISE EXCEPTION 'Tweak 4: service_role (ops-api) must read the bill count view';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                 WHERE oid = 'public.dispatch_approved_supplier_contact_bills'::regclass
                   AND 'security_invoker=true' = ANY (reloptions)) THEN
    RAISE EXCEPTION 'Tweak 4: the bill count view must read with the caller''s rights (security_invoker)';
  END IF;
END $$;
