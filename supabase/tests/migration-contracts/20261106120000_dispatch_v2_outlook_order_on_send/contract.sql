-- Section 3g (6 Nov 2026): an order sent from Outlook is recorded when it is sent. One order per sent email and
-- supplier, a second order to the same supplier reuses the box, Dispatch's own sends are refused. Synthetic ids;
-- every write rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j_vesna uuid := 'd1800000-0000-4000-8000-000000000001';
  j_own uuid := 'd1800000-0000-4000-8000-000000000002';
  s_rr uuid := 'd1800000-0000-4000-8000-000000000011';
  s_rr2 uuid := 'd1800000-0000-4000-8000-000000000012';
  s_metroll uuid := 'd1800000-0000-4000-8000-000000000013';
  s_old uuid := 'd1800000-0000-4000-8000-000000000014';
  ev1 uuid := 'd1800000-0000-4000-8000-000000000021';
  ev2 uuid := 'd1800000-0000-4000-8000-000000000022';
  ev3 uuid := 'd1800000-0000-4000-8000-000000000023';
  p jsonb;
  r jsonb;
  r2 jsonb;
  n int;
  o record;
BEGIN
  INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
    (j_vesna, org, 'scheduled', 'fencing', 'SWF-882586'),
    (j_own, org, 'scheduled', 'fencing', 'SWF-882587');
  INSERT INTO public.suppliers (id, name, is_active) VALUES
    (s_rr, 'R&R Fencing', true), (s_rr2, 'R&R FENCING', true), (s_metroll, 'Metroll', true),
    (s_old, 'Old Supplier', false);

  p := jsonb_build_object(
    'org_id', org, 'job_id', j_vesna, 'supplier_id', s_rr, 'related_supplier_ids', jsonb_build_array(s_rr, s_rr2),
    'approved_email_id', NULL, 'trigger', 'send',
    'work_type', 'fencing', 'team_cc_email', 'fencing@secureworkswa.com.au',
    'to_emails', jsonb_build_array('sales@randrfencing.com.au'),
    'cc_emails', jsonb_build_array('fencing@secureworkswa.com.au'),
    'subject', 'Material Order Ref SWF-882586',
    'body_text', 'Hi Team, could we please order the attached list for delivery.',
    'delivery_date', NULL,
    'order_lines', '[]'::jsonb,
    'standing_lines_included', false,
    'sent_at', '2026-11-03T09:05:03Z', 'sent_by_email', 'admin@secureworkswa.com.au',
    'sent_from_mailbox', 'admin@secureworkswa.com.au',
    'sent_internet_message_id', 'vesna@outlook.example', 'sent_conversation_id', 'CONV-VESNA',
    'source_business_event_id', ev1);

  -- 1. Recorded with no lines (the email's words are the order): the box, the sent row, one job_events row.
  r := public.dispatch_v2_record_outlook_order_on_send(p);
  IF NOT (r->>'recorded')::boolean OR NOT (r->>'box_created')::boolean OR r->>'box_id' IS NULL THEN
    RAISE EXCEPTION 'contract 1: not recorded: %', r;
  END IF;
  SELECT * INTO o FROM public.dispatch_supplier_order_emails WHERE id = (r->>'order_id')::uuid;
  IF o.status <> 'sent' OR o.origin <> 'outlook' OR o.source_business_event_id <> ev1
     OR jsonb_array_length(o.order_lines) <> 0 OR o.body_text <> o.built_body_text THEN
    RAISE EXCEPTION 'contract 1: order row wrong: %', row_to_json(o);
  END IF;
  SELECT count(*) INTO n FROM public.job_events
   WHERE job_id = j_vesna AND event_type = 'dispatch_v2_outlook_order_recorded' AND detail_json->>'trigger' = 'send';
  IF n <> 1 THEN RAISE EXCEPTION 'contract 1: % job_events rows', n; END IF;

  -- 2. The same sent email for the same supplier (any of its contacts) hands back the same order.
  r2 := public.dispatch_v2_record_outlook_order_on_send(p || jsonb_build_object('supplier_id', s_rr2));
  IF (r2->>'recorded')::boolean OR r2->>'reason' <> 'already_recorded' OR r2->>'order_id' <> r->>'order_id' THEN
    RAISE EXCEPTION 'contract 2: not idempotent: %', r2;
  END IF;

  -- 3. The same sent email to a second supplier is that supplier's order too.
  r2 := public.dispatch_v2_record_outlook_order_on_send(
    p || jsonb_build_object('supplier_id', s_metroll, 'related_supplier_ids', jsonb_build_array(s_metroll)));
  IF NOT (r2->>'recorded')::boolean THEN RAISE EXCEPTION 'contract 3: %', r2; END IF;
  SELECT count(*) INTO n FROM public.dispatch_supplier_order_emails WHERE source_business_event_id = ev1;
  IF n <> 2 THEN RAISE EXCEPTION 'contract 3: % orders from one email', n; END IF;

  -- 4. A second sent email to the same supplier on the job: a second order, the same box.
  r2 := public.dispatch_v2_record_outlook_order_on_send(
    p || jsonb_build_object('source_business_event_id', ev2, 'sent_at', '2026-11-04T01:00:00Z',
                            'sent_internet_message_id', 'vesna2@outlook.example', 'sent_conversation_id', 'CONV-2',
                            'trigger', 'catch_up'));
  IF NOT (r2->>'recorded')::boolean OR (r2->>'box_created')::boolean OR r2->>'box_id' <> r->>'box_id' THEN
    RAISE EXCEPTION 'contract 4: %', r2;
  END IF;
  SELECT count(*) INTO n FROM public.job_material_suppliers WHERE job_id = j_vesna AND supplier_id = s_rr;
  IF n <> 1 THEN RAISE EXCEPTION 'contract 4: % boxes', n; END IF;
  SELECT count(*) INTO n FROM public.job_events
   WHERE job_id = j_vesna AND detail_json->>'trigger' = 'catch_up';
  IF n <> 1 THEN RAISE EXCEPTION 'contract 4: catch_up event %', n; END IF;

  -- 5. Dispatch's own send (its copy in admin@ Sent): refused by message id (any case, angle brackets) or thread.
  INSERT INTO public.dispatch_supplier_order_emails
    (org_id, job_id, supplier_id, supplier_name, status, subject, to_emails, body_text, built_body_text, sent_at,
     sent_internet_message_id, sent_conversation_id)
  VALUES (org, j_own, s_rr, 'R&R Fencing', 'sent', 'Material Order Ref SWF-882587',
          ARRAY['sales@randrfencing.com.au'], 'x', 'x', '2026-11-05T01:00:00Z', '<OWN@dispatch.example>', 'CONV-OWN');
  r2 := public.dispatch_v2_record_outlook_order_on_send(
    p || jsonb_build_object('job_id', j_own, 'source_business_event_id', ev3,
                            'sent_internet_message_id', 'own@dispatch.example', 'sent_conversation_id', 'CONV-X'));
  IF r2->>'reason' <> 'dispatch_own_send' THEN RAISE EXCEPTION 'contract 5: %', r2; END IF;
  r2 := public.dispatch_v2_record_outlook_order_on_send(
    p || jsonb_build_object('job_id', j_own, 'source_business_event_id', ev3,
                            'sent_internet_message_id', 'other@outlook.example', 'sent_conversation_id', 'CONV-OWN'));
  IF r2->>'reason' <> 'dispatch_own_send' THEN RAISE EXCEPTION 'contract 5b: %', r2; END IF;
  SELECT count(*) INTO n FROM public.dispatch_supplier_order_emails WHERE job_id = j_own;
  IF n <> 1 THEN RAISE EXCEPTION 'contract 5: % rows on the own-send job', n; END IF;

  -- 6. An inactive supplier or an unknown job records nothing; a bad trigger is refused.
  r2 := public.dispatch_v2_record_outlook_order_on_send(
    p || jsonb_build_object('supplier_id', s_old, 'related_supplier_ids', jsonb_build_array(s_old),
                            'source_business_event_id', 'd1800000-0000-4000-8000-000000000024'));
  IF r2->>'reason' <> 'supplier_inactive' THEN RAISE EXCEPTION 'contract 6: %', r2; END IF;
  r2 := public.dispatch_v2_record_outlook_order_on_send(
    p || jsonb_build_object('job_id', 'd1800000-0000-4000-8000-000000000099',
                            'source_business_event_id', 'd1800000-0000-4000-8000-000000000025'));
  IF r2->>'reason' <> 'job_not_found' THEN RAISE EXCEPTION 'contract 6b: %', r2; END IF;
  BEGIN
    PERFORM public.dispatch_v2_record_outlook_order_on_send(
      p || jsonb_build_object('trigger', 'reply', 'source_business_event_id', 'd1800000-0000-4000-8000-000000000026'));
    RAISE EXCEPTION 'contract 6c: a bad trigger was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'outlook_order_bad_trigger' THEN RAISE; END IF;
  END;

  -- 7. The keys: one order per sent email and supplier; the 5 Nov one-per-email index is gone.
  IF to_regclass('public.dispatch_supplier_order_emails_source_event_supplier_idx') IS NULL
     OR to_regclass('public.dispatch_supplier_order_emails_source_event_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'contract 7: indexes wrong';
  END IF;
  BEGIN
    INSERT INTO public.dispatch_supplier_order_emails
      (org_id, job_id, supplier_id, supplier_name, status, subject, to_emails, body_text, built_body_text, sent_at,
       origin, source_business_event_id)
    VALUES (org, j_vesna, s_rr, 'R&R Fencing', 'sent', 'x', ARRAY['a@b.example'], 'x', 'x', now(), 'outlook', ev1);
    RAISE EXCEPTION 'contract 7b: a second order for one email and supplier was allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 8. The send rule's start time, empty until the first run.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'dispatch_v2_reply_scan_state' AND column_name = 'sent_orders_since'
                  AND data_type = 'timestamp with time zone') THEN
    RAISE EXCEPTION 'contract 8: sent_orders_since missing';
  END IF;

  -- 9. Only the service role may call it.
  IF has_function_privilege('anon', 'public.dispatch_v2_record_outlook_order_on_send(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.dispatch_v2_record_outlook_order_on_send(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.dispatch_v2_record_outlook_order_on_send(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract 9: wrong callers';
  END IF;
END $$;
ROLLBACK;
