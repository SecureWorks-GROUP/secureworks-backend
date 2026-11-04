-- After the down: v_dispatch_order_bills is the 20261104010000 view again, byte for byte, without the three
-- columns 20261104040000 added, still service role only, and still answering.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true)) <> 'b383b75b2c114c37758060a5e5493f3f' THEN
    RAISE EXCEPTION 'rollback did not restore the 20261104010000 view (md5 %)', md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'v_dispatch_order_bills'
              AND column_name IN ('matched_po_number', 'matched_site_address', 'matched_in')) THEN
    RAISE EXCEPTION 'rollback left the rule (c) and (d) columns behind';
  END IF;
  IF has_table_privilege('anon', 'public.v_dispatch_order_bills', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_dispatch_order_bills', 'SELECT') THEN
    RAISE EXCEPTION 'rollback changed who reads v_dispatch_order_bills';
  END IF;
  PERFORM count(*) FROM public.v_dispatch_order_bills;
END $$;
