-- After rollback: both C1c objects are gone and the writer and ladder are untouched.
DO $$
BEGIN
 IF to_regprocedure('public.record_ghl_webhook_receipt(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'c1c rollback: writer still exists'; END IF;
 IF to_regclass('public.ghl_webhook_receipts') IS NOT NULL THEN RAISE EXCEPTION 'c1c rollback: table still exists'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.capture_business_event(jsonb)'))<>'4819869e6dcc40d5cd19a7eba295392c'
 THEN RAISE EXCEPTION 'c1c rollback: capture_business_event changed'; END IF;
END $$;
