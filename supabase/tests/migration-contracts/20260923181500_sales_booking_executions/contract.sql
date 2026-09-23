BEGIN;
DO $$
DECLARE
  snap jsonb := jsonb_build_object(
    'schema','scope-booking-approval.v1', 'step','message','resource','marnin',
    'week_start','2026-09-21','content_hash',repeat('b',64), 'content','{}'::jsonb,
    'pack_revision',repeat('c',64),'contact_id','synthetic');
  cal jsonb := jsonb_build_object(
    'schema','scope-booking-approval.v1', 'step','calendar','resource','marnin',
    'week_start','2026-09-21','content_hash',repeat('d',64), 'content','{}'::jsonb,
    'pack_revision',repeat('c',64),'contact_id','synthetic');
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sales_booking_executions'::regclass) THEN
    RAISE EXCEPTION 'executor ledger requires RLS';
  END IF;
  IF has_table_privilege('authenticated','public.sales_booking_executions','SELECT') OR
     has_table_privilege('anon','public.sales_booking_executions','INSERT') OR
     has_table_privilege('service_role','public.sales_booking_executions','DELETE') THEN
    RAISE EXCEPTION 'executor ledger must be private and never deleted';
  END IF;
  IF NOT has_table_privilege('service_role','public.sales_booking_executions','SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'service adapter cannot claim/settle executions';
  END IF;
  INSERT INTO public.sales_booking_approvals VALUES
    (repeat('a',64),'message','marnin','2026-09-21','approved',NULL,snap,
     '706c5258-70dd-483a-b36c-af6864b24498','captain@example.test','2026-09-22T00:00Z','2026-09-22T00:15Z'),
    (repeat('b',64),'calendar','marnin','2026-09-21','approved',NULL,cal,
     '706c5258-70dd-483a-b36c-af6864b24498','captain@example.test','2026-09-22T00:00Z','2026-09-22T00:15Z');
  BEGIN
    INSERT INTO public.sales_booking_executions
      (binding_hash, step, contact_id, state, press_token, claimed_by_email)
      VALUES (repeat('9',64),'message','synthetic','sending','11111111-1111-4111-8111-111111111111','captain@example.test');
    RAISE EXCEPTION 'execution without an approval row was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  INSERT INTO public.sales_booking_executions
    (binding_hash, step, contact_id, state, press_token, claimed_by_email)
    VALUES (repeat('a',64),'message','synthetic','sending','11111111-1111-4111-8111-111111111111','captain@example.test');
  BEGIN
    INSERT INTO public.sales_booking_executions
      (binding_hash, step, contact_id, state, press_token, claimed_by_email)
      VALUES (repeat('a',64),'message','synthetic','sending','22222222-2222-4222-8222-222222222222','captain@example.test');
    RAISE EXCEPTION 'second claim on one approval was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE public.sales_booking_executions SET state='sent', finished_at=now()
      WHERE binding_hash=repeat('a',64);
    RAISE EXCEPTION 'sent without a provider message id was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE public.sales_booking_executions SET state='sent', message_id='msg-1', finished_at=now()
    WHERE binding_hash=repeat('a',64) AND state='sending';
  BEGIN
    UPDATE public.sales_booking_executions SET state='unknown', message_id=NULL
      WHERE binding_hash=repeat('a',64);
    RAISE EXCEPTION 'a settled send was changed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%settles once%' THEN RAISE; END IF;
  END;
  INSERT INTO public.sales_booking_executions
    (binding_hash, step, contact_id, state, press_token, claimed_by_email)
    VALUES (repeat('b',64),'calendar','synthetic','claimed','33333333-3333-4333-8333-333333333333','captain@example.test');
  UPDATE public.sales_booking_executions
    SET press_token='44444444-4444-4444-8444-444444444444', claimed_at=now()
    WHERE binding_hash=repeat('b',64) AND state='claimed';
  UPDATE public.sales_booking_executions
    SET state='booked', appointment_id='appt-1', finished_at=now()
    WHERE binding_hash=repeat('b',64) AND state='claimed';
  BEGIN
    UPDATE public.sales_booking_executions
      SET press_token='55555555-5555-4555-8555-555555555555', claimed_at=now()
      WHERE binding_hash=repeat('b',64);
    RAISE EXCEPTION 'a booked calendar claim was re-claimed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%settles once%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
