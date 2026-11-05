-- Prerequisites for 20261105130000_dispatch_v2_outlook_orders: the registered stack supplies jobs, suppliers and
-- job_events (stand-ins), job_material_suppliers (20261014130000) and a narrow dispatch_supplier_order_emails
-- stand-in (20261104010000). Added here, without changing anything an earlier registered case created: the columns
-- the function writes that the stand-ins lack (production types: 20261023214200 for the order email columns,
-- suppliers.is_active from the Xero sync).
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.dispatch_supplier_order_emails
  ADD COLUMN IF NOT EXISTS approved_email_id uuid,
  ADD COLUMN IF NOT EXISTS work_type text,
  ADD COLUMN IF NOT EXISTS is_main_supplier boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS standing_lines_included boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS team_cc_email text,
  ADD COLUMN IF NOT EXISTS to_emails text[],
  ADD COLUMN IF NOT EXISTS cc_emails text[],
  ADD COLUMN IF NOT EXISTS body_text text,
  ADD COLUMN IF NOT EXISTS built_body_text text,
  ADD COLUMN IF NOT EXISTS delivery_date date,
  ADD COLUMN IF NOT EXISTS order_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sent_by_email text,
  ADD COLUMN IF NOT EXISTS sent_from_mailbox text,
  ADD COLUMN IF NOT EXISTS sent_to_emails text[],
  ADD COLUMN IF NOT EXISTS sent_cc_emails text[],
  ADD COLUMN IF NOT EXISTS sent_internet_message_id text,
  ADD COLUMN IF NOT EXISTS sent_conversation_id text;
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.jobs', 'public.suppliers', 'public.job_events', 'public.job_material_suppliers',
                           'public.dispatch_supplier_order_emails'] LOOP
    IF to_regclass(t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN missing := missing || ('role ' || t); END IF;
  END LOOP;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'Tweak 2 outlook orders prerequisites missing: %', array_to_string(missing, ', ');
  END IF;
END $$;
