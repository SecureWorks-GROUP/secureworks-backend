BEGIN;
DO $$
DECLARE snap jsonb := jsonb_build_object(
  'schema','scope-booking-approval.v1', 'step','calendar','resource','marnin',
  'week_start','2026-09-21','content_hash',repeat('b',64), 'content','{}'::jsonb,
  'pack_revision',repeat('c',64),'contact_id','synthetic');
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sales_booking_approvals'::regclass) THEN
    RAISE EXCEPTION 'approval store requires RLS';
  END IF;
  IF has_table_privilege('authenticated','public.sales_booking_approvals','SELECT') OR
     has_table_privilege('anon','public.sales_booking_approvals','INSERT') OR
     has_table_privilege('service_role','public.sales_booking_approvals','UPDATE') OR
     has_table_privilege('service_role','public.sales_booking_approvals','DELETE') THEN
    RAISE EXCEPTION 'approval store must be private and append only';
  END IF;
  IF NOT has_table_privilege('service_role','public.sales_booking_approvals','SELECT,INSERT') THEN
    RAISE EXCEPTION 'service adapter cannot persist/read approvals';
  END IF;
  INSERT INTO public.sales_booking_approvals VALUES
    (repeat('a',64),'calendar','marnin','2026-09-21','approved',NULL,snap,
     '706c5258-70dd-483a-b36c-af6864b24498','captain@example.test','2026-09-22T00:00Z','2026-09-22T00:15Z');
  BEGIN
    INSERT INTO public.sales_booking_approvals SELECT * FROM public.sales_booking_approvals WHERE binding_hash=repeat('a',64);
    RAISE EXCEPTION 'duplicate binding was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.sales_booking_approvals VALUES
      (repeat('d',64),'message','marnin','2026-09-21','approved',NULL,snap,
       '706c5258-70dd-483a-b36c-af6864b24498','captain@example.test','2026-09-22T00:00Z','2026-09-22T00:15Z');
    RAISE EXCEPTION 'one step authorized another';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.sales_booking_approvals VALUES
      (repeat('e',64),'calendar','marnin','2026-09-21','approved',NULL,snap,
       '706c5258-70dd-483a-b36c-af6864b24498','captain@example.test','2026-09-22T00:00Z','2026-09-22T00:16Z');
    RAISE EXCEPTION 'approval exceeded 15 minutes';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.sales_booking_approvals VALUES
    (repeat('f',64),'message','marnin','2026-09-21','refused','Wording needs review',jsonb_set(snap,'{step}','"message"'),
     '706c5258-70dd-483a-b36c-af6864b24498','captain@example.test','2026-09-22T00:00Z','2026-09-22T00:15Z');
  IF (SELECT count(*) FROM public.sales_booking_approvals WHERE snapshot->>'contact_id'='synthetic') <> 2 THEN
    RAISE EXCEPTION 'independent steps did not persist';
  END IF;
END $$;
ROLLBACK;
