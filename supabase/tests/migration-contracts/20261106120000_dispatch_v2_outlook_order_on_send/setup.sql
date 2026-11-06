-- Prerequisites for 20261106120000_dispatch_v2_outlook_order_on_send: the registered stack supplies jobs, suppliers,
-- job_events, job_material_suppliers and dispatch_supplier_order_emails (with origin, source_business_event_id and the
-- 5 Nov one-order-per-email index from 20261105170000). Added here, without changing anything an earlier registered
-- case created: a stand-in for dispatch_v2_reply_scan_state (production: 20261023230000, not a registered case).
CREATE TABLE IF NOT EXISTS public.dispatch_v2_reply_scan_state (
  id text PRIMARY KEY DEFAULT 'default',
  cursor_sequence bigint NULL,
  last_scan_at timestamptz NULL,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.jobs', 'public.suppliers', 'public.job_events', 'public.job_material_suppliers',
                           'public.dispatch_supplier_order_emails', 'public.dispatch_v2_reply_scan_state'] LOOP
    IF to_regclass(t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'dispatch_supplier_order_emails' AND column_name = 'source_business_event_id') THEN
    missing := missing || 'dispatch_supplier_order_emails.source_business_event_id';
  END IF;
  FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN missing := missing || ('role ' || t); END IF;
  END LOOP;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'Outlook order on send prerequisites missing: %', array_to_string(missing, ', ');
  END IF;
END $$;
