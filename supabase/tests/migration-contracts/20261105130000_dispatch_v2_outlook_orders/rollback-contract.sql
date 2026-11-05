-- After the down: the function, the index, both checks and both columns are gone; the order table still answers.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regprocedure('public.dispatch_v2_record_outlook_order(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left the function';
  END IF;
  IF to_regclass('public.dispatch_supplier_order_emails_source_event_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left the index';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'dispatch_supplier_order_emails' AND column_name IN ('origin', 'source_business_event_id')) THEN
    RAISE EXCEPTION 'rollback left a column';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('dispatch_supplier_order_emails_origin_valid',
              'dispatch_supplier_order_emails_outlook_shape')) THEN
    RAISE EXCEPTION 'rollback left a check';
  END IF;
  PERFORM count(*) FROM public.dispatch_supplier_order_emails;
END $$;
