BEGIN;
DO $$
DECLARE snap jsonb := jsonb_build_object(
  'schema','scope-booking-approval.v1', 'step','message','resource','marnin',
  'week_start','2026-09-21','content_hash',repeat('b',64), 'content','{}'::jsonb,
  'pack_revision',repeat('c',64),'contact_id','synthetic');
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sales_booking_message_sends'::regclass) THEN
    RAISE EXCEPTION 'send ledger requires RLS';
  END IF;
  IF has_table_privilege('authenticated','public.sales_booking_message_sends','SELECT') OR
     has_table_privilege('anon','public.sales_booking_message_sends','INSERT') OR
     has_table_privilege('service_role','public.sales_booking_message_sends','DELETE') THEN
    RAISE EXCEPTION 'send ledger must be private and never deleted';
  END IF;
  IF NOT has_table_privilege('service_role','public.sales_booking_message_sends','SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'service adapter cannot claim/settle sends';
  END IF;
  INSERT INTO public.sales_booking_approvals VALUES
    (repeat('a',64),'message','marnin','2026-09-21','approved',NULL,snap,
     '706c5258-70dd-483a-b36c-af6864b24498','captain@example.test','2026-09-22T00:00Z','2026-09-22T00:15Z');
  BEGIN
    INSERT INTO public.sales_booking_message_sends (binding_hash, contact_id, state, claimed_by_email)
      VALUES (repeat('9',64),'synthetic','sending','captain@example.test');
    RAISE EXCEPTION 'send without an approval row was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  INSERT INTO public.sales_booking_message_sends (binding_hash, contact_id, state, claimed_by_email)
    VALUES (repeat('a',64),'synthetic','sending','captain@example.test');
  BEGIN
    INSERT INTO public.sales_booking_message_sends (binding_hash, contact_id, state, claimed_by_email)
      VALUES (repeat('a',64),'synthetic','sending','captain@example.test');
    RAISE EXCEPTION 'second claim on one approval was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE public.sales_booking_message_sends SET state='sent', finished_at=now()
      WHERE binding_hash=repeat('a',64);
    RAISE EXCEPTION 'sent without a provider message id was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE public.sales_booking_message_sends SET state='sent', message_id='msg-1', finished_at=now()
    WHERE binding_hash=repeat('a',64) AND state='sending';
  BEGIN
    UPDATE public.sales_booking_message_sends SET state='unknown', message_id=NULL
      WHERE binding_hash=repeat('a',64);
    RAISE EXCEPTION 'a settled send was changed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%settles once%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
