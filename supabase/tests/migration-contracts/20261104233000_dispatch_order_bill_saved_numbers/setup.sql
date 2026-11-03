-- Prerequisites for 20261104233000_dispatch_order_bill_saved_numbers: the registered stack supplies the two
-- Dispatch order views (20261104010000, 20261104040000), the email reader's attachments (20261002150000) and
-- business_events. Added here, without changing anything an earlier registered case created: the columns rules (e)
-- and (f) read that the stack's stand-ins lack (production types: purchase_orders.reference and .notes text,
-- 20261014150000; dispatch_supplier_order_emails.sent_to_emails text[], 20261023214200).
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.dispatch_supplier_order_emails ADD COLUMN IF NOT EXISTS sent_to_emails text[];
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.v_dispatch_order_bills') IS NULL THEN missing := missing || 'v_dispatch_order_bills'; END IF;
  IF to_regclass('public.v_dispatch_orders') IS NULL THEN missing := missing || 'v_dispatch_orders'; END IF;
  IF to_regclass('public.context_email_attachments') IS NULL THEN missing := missing || 'context_email_attachments'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_email_attachments'
                  AND column_name = 'sha256') THEN
    missing := missing || 'context_email_attachments.sha256';
  END IF;
  IF to_regclass('public.business_events') IS NULL THEN missing := missing || 'business_events'; END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'B4 saved-numbers prerequisites missing: %', array_to_string(missing, ', ');
  END IF;
END $$;
