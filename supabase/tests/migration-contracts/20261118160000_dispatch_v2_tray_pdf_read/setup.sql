-- Prerequisites for 20261118160000_dispatch_v2_tray_pdf_read. Every table this migration reads already exists in
-- the earlier registered fixtures (business_events, jobs, context_email_attachments, the B-5 document text records,
-- the B-5b vision records and context_document_text_requests), except three columns of the narrow
-- dispatch_v2_supplier_emails stand-in (20261105171000's setup) that production has had since
-- 20261023230000_dispatch_v2_replies_tables.sql: provider_message_id, received_at and order_desk.
ALTER TABLE public.dispatch_v2_supplier_emails ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE public.dispatch_v2_supplier_emails ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE public.dispatch_v2_supplier_emails ADD COLUMN IF NOT EXISTS order_desk boolean NOT NULL DEFAULT false;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.dispatch_v2_supplier_emails','public.context_email_attachments','public.business_events',
    'public.jobs','public.context_document_texts','public.context_document_vision_reads','public.context_document_text_requests'] LOOP
    IF to_regclass(t) IS NULL THEN RAISE EXCEPTION 'item 16b prerequisites missing: %', t; END IF;
  END LOOP;
END $$;
