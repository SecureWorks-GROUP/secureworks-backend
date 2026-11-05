-- Prerequisites for 20261105184500_dispatch_v2_supplier_picker (Dispatch v2 Tweak 4, the simpler supplier picker).
-- The registered stack supplies suppliers (20261002150000 stand-in), xero_invoices (20260911061500 stand-in) and
-- dispatch_approved_supplier_emails (20261104102000 stand-in). Added here, without changing anything an earlier
-- registered case created:
--   * the links table (20261023214100 is not a registered case), with its production shape;
--   * the columns the bill count view reads that the stand-ins lack (production types, read 5 Nov 2026:
--     suppliers.org_id uuid, suppliers.xero_contact_id text, xero_invoices.xero_contact_id text,
--     xero_invoices.invoice_date date, xero_invoices.status text).
-- Then the rows the migration's one-off data changes match, so contract.sql can prove each change landed:
-- the B&D and R&R renames, the Ampelite CC removal and the CMI pin. Every fixture id starts 7e4a (unique in
-- this shared database), and the emails are example.test addresses except the two Ampelite ones the
-- migration matches by value.

ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS org_id uuid DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS xero_contact_id text;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS xero_contact_id text;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS invoice_date date;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS invoice_number text;

CREATE TABLE IF NOT EXISTS public.dispatch_approved_supplier_email_links (
  supplier_id uuid PRIMARY KEY REFERENCES public.suppliers(id) ON DELETE CASCADE,
  approved_id uuid NOT NULL REFERENCES public.dispatch_approved_supplier_emails(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_email text NULL
);

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.suppliers', 'public.xero_invoices', 'public.dispatch_approved_supplier_emails',
                           'public.dispatch_approved_supplier_email_links'] LOOP
    IF to_regclass(t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN missing := missing || ('role ' || t); END IF;
  END LOOP;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'Tweak 4 supplier picker prerequisites missing: %', array_to_string(missing, ', ');
  END IF;
END $$;

-- The Xero contacts (CMI WA keeps its production id: the migration pins that id).
INSERT INTO public.suppliers (id, name, org_id, is_active, xero_contact_id) VALUES
  ('7e4a0000-0000-4000-8000-000000000001', 'Tweak4 Jaiama T/A B&D Metals Group', '00000000-0000-0000-0000-000000000001', true, 'tw4-xc-bd'),
  ('7e4a0000-0000-4000-8000-000000000002', 'Tweak4 R&R FENCING', '00000000-0000-0000-0000-000000000001', true, 'tw4-xc-rr'),
  ('7e4a0000-0000-4000-8000-000000000003', 'Tweak4 AMPELITE AUSTRALIA', '00000000-0000-0000-0000-000000000001', true, 'tw4-xc-amp'),
  ('cad56667-fb78-4232-948e-0d6457d9626f', 'CMI (Combined Metal Industries / CMI WA)', '00000000-0000-0000-0000-000000000001', true, 'tw4-xc-cmiwa'),
  ('7e4a0000-0000-4000-8000-000000000005', 'Tweak4 Trustee 36 CMI', '00000000-0000-0000-0000-000000000001', true, 'tw4-xc-cmitrustee')
ON CONFLICT (id) DO NOTHING;

-- The approved entries as they stand before the migration. 7e4a...15 is the same name in another organisation:
-- the migration must leave it alone.
INSERT INTO public.dispatch_approved_supplier_emails (id, org_id, name, to_emails, cc_emails) VALUES
  ('7e4a0000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000001', 'B&D Metals Group',
   ARRAY['tw4-orders@bd.example.test'], ARRAY[]::text[]),
  ('7e4a0000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001', 'R&R Fencing',
   ARRAY['tw4-orders@rr.example.test'], ARRAY[]::text[]),
  ('7e4a0000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000001', 'Ampelite',
   ARRAY['waorders@ampelite.com.au'], ARRAY['warwick@ampelite.com.au', 'tw4-keep@ampelite.example.test']),
  ('7e4a0000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', 'CMI (Combined Metal Industries)',
   ARRAY['tw4-orders@cmi.example.test'], ARRAY[]::text[]),
  ('7e4a0000-0000-4000-8000-000000000015', '7e4a0000-0000-4000-8000-000000000099', 'R&R Fencing',
   ARRAY['tw4-orders@rr-other.example.test'], ARRAY[]::text[])
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.dispatch_approved_supplier_email_links (supplier_id, approved_id, org_id) VALUES
  ('7e4a0000-0000-4000-8000-000000000001', '7e4a0000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000001'),
  ('7e4a0000-0000-4000-8000-000000000002', '7e4a0000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001'),
  ('7e4a0000-0000-4000-8000-000000000003', '7e4a0000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000001'),
  ('cad56667-fb78-4232-948e-0d6457d9626f', '7e4a0000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001'),
  ('7e4a0000-0000-4000-8000-000000000005', '7e4a0000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (supplier_id) DO NOTHING;
