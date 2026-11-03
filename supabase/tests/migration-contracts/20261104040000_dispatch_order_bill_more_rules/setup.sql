-- Prerequisites for 20261104040000_dispatch_order_bill_more_rules. The registered stack supplies every one:
-- 20261104010000 (the two Dispatch order views), 20261002150000 (context_email_attachments), 20261005210000
-- (context_document_texts), 20261006001000 (context_document_vision_reads) and 20260924183000 (the context
-- placer's address key). Nothing is created here; a missing one stops the walk with its name.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.v_dispatch_order_bills') IS NULL THEN missing := missing || 'v_dispatch_order_bills'; END IF;
  IF to_regclass('public.context_email_attachments') IS NULL THEN missing := missing || 'context_email_attachments'; END IF;
  IF to_regclass('public.context_document_texts') IS NULL THEN missing := missing || 'context_document_texts'; END IF;
  IF to_regclass('public.context_document_vision_reads') IS NULL THEN missing := missing || 'context_document_vision_reads'; END IF;
  IF to_regprocedure('public.context_address_mentions(text)') IS NULL THEN missing := missing || 'context_address_mentions(text)'; END IF;
  IF to_regprocedure('public.context_address_key(text)') IS NULL THEN missing := missing || 'context_address_key(text)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'site_address') THEN
    missing := missing || 'jobs.site_address';
  END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'B4 more-rules prerequisites missing: %', array_to_string(missing, ', ');
  END IF;
END $$;
