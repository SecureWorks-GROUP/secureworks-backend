-- After the down: v_dispatch_order_bills is the 20261104040000 view again, byte for byte, with its comment, still
-- service role only, still answering, and the rows rules (e) and (f) gave are gone.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true)) <> '4bb5ce8ad2c5a57cf3d34df0e3c8bfd6' THEN
    RAISE EXCEPTION 'rollback did not restore the 20261104040000 view (md5 %)', md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true));
  END IF;
  IF obj_description('public.v_dispatch_order_bills'::regclass, 'pg_class') NOT LIKE 'B4 20261104010000, rules (c) and (d) 20261104040000: %'
     OR obj_description('public.v_dispatch_order_bills'::regclass, 'pg_class') LIKE '%20261104233000%' THEN
    RAISE EXCEPTION 'rollback did not restore the 20261104040000 comment';
  END IF;
  IF has_table_privilege('anon', 'public.v_dispatch_order_bills', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_dispatch_order_bills', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_dispatch_order_bills', 'SELECT') THEN
    RAISE EXCEPTION 'rollback changed who reads v_dispatch_order_bills';
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE rule LIKE '%bill_number%' OR matched_in LIKE '%pdf_email%' OR matched_in LIKE '%order%') THEN
    RAISE EXCEPTION 'rollback left a rule (e) or (f) row';
  END IF;
END $$;
