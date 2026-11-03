-- After the down migration: both functions are byte for byte the 3 Nov live definitions,
-- access is unchanged, and the block no longer lists the record sources or lanes.
DO $$
DECLARE s jsonb:=public.context_source_freshness(); sig text; f regprocedure;
BEGIN
 IF md5(pg_get_functiondef('public.context_source_freshness_policy()'::regprocedure))<>'99b406e26bec8e15a9b7bf5006ec0bfd'
  OR md5(pg_get_functiondef('public.context_source_freshness()'::regprocedure))<>'94ed3bbdf9b58eb990166e8a768cf573'
 THEN RAISE EXCEPTION 'capture_quiet_lanes rollback: definitions not restored'; END IF;
 IF s ? 'lanes' OR s->'policy' ? 'quiet_limits' OR s->'policy' ? 'lanes'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'sources') x WHERE x->>'source' IN ('xero/bills','xero/invoices','xero/payments','quotes/sent','bookings/crew','documents/files','documents/photos'))
 THEN RAISE EXCEPTION 'capture_quiet_lanes rollback: C1 output still present %',s; END IF;
 IF obj_description('public.context_source_freshness()'::regprocedure,'pg_proc') LIKE '%C1 (20261103230000)%'
 THEN RAISE EXCEPTION 'capture_quiet_lanes rollback: comment not restored'; END IF;
 FOREACH sig IN ARRAY ARRAY['public.context_source_freshness()','public.context_source_freshness_policy()'] LOOP
  f:=sig::regprocedure;
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
   OR has_function_privilege('public',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'capture_quiet_lanes rollback: % access changed',sig; END IF;
 END LOOP;
END $$;
