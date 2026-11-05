-- Tweak 2 piece 1 (5 Nov 2026): an order Shaun sent from Outlook becomes a sent Dispatch order. Shapes from Vesna's
-- order SWF-261586 to R&R Fencing (3 Nov 2026; R&R is three Xero contacts). Synthetic ids; every write rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j_vesna uuid := 'f2000000-0000-4000-8000-000000000001';
  j_drafted uuid := 'f2000000-0000-4000-8000-000000000002';
  j_boxed uuid := 'f2000000-0000-4000-8000-000000000003';
  s_rr uuid := 'f2000000-0000-4000-8000-000000000011';
  s_rr2 uuid := 'f2000000-0000-4000-8000-000000000012';
  s_old uuid := 'f2000000-0000-4000-8000-000000000013';
  ev1 uuid := 'f2000000-0000-4000-8000-000000000021';
  ev2 uuid := 'f2000000-0000-4000-8000-000000000022';
  ev3 uuid := 'f2000000-0000-4000-8000-000000000023';
  p jsonb;
  r jsonb;
  r2 jsonb;
  n int;
  o record;
BEGIN
  INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
    (j_vesna, org, 'scheduled', 'fencing', 'SWF-872586'),
    (j_drafted, org, 'scheduled', 'fencing', 'SWF-872587'),
    (j_boxed, org, 'scheduled', 'fencing', 'SWF-872588');
  INSERT INTO public.suppliers (id, name, is_active) VALUES
    (s_rr, 'R&R Fencing', true), (s_rr2, 'R&R FENCING', true), (s_old, 'Old Supplier', false);

  p := jsonb_build_object(
    'org_id', org, 'job_id', j_vesna, 'supplier_id', s_rr, 'related_supplier_ids', jsonb_build_array(s_rr, s_rr2),
    'work_type', 'fencing', 'team_cc_email', 'fencing@secureworkswa.com.au',
    'to_emails', jsonb_build_array('sales@randrfencing.com.au'),
    'cc_emails', jsonb_build_array('fencing@secureworkswa.com.au'),
    'subject', 'Material Order Ref SWF-872586',
    'body_text', 'Hi Team, could we please order the following for delivery: Materials Needed: 1. 14 x panels',
    'delivery_date', '2026-11-12',
    'order_lines', jsonb_build_array(jsonb_build_object('line_id', NULL, 'updated_at', NULL, 'text', '14 x panels',
                                                        'standing', false)),
    'standing_lines_included', false,
    'sent_at', '2026-11-03T09:05:03Z', 'sent_by_email', 'admin@secureworkswa.com.au',
    'sent_from_mailbox', 'admin@secureworkswa.com.au',
    'sent_internet_message_id', 'vesna@outlook.example', 'sent_conversation_id', 'CONV-VESNA',
    'source_business_event_id', ev1, 'reply_email_id', NULL);

  -- 1. Recorded: the box (last, not main), the sent order (origin outlook) and one job_events row.
  r := public.dispatch_v2_record_outlook_order(p);
  IF NOT (r->>'recorded')::boolean OR NOT (r->>'box_created')::boolean OR r->>'reason' IS NOT NULL THEN
    RAISE EXCEPTION 'contract 1: not recorded: %', r;
  END IF;
  SELECT * INTO o FROM public.dispatch_supplier_order_emails WHERE id = (r->>'order_id')::uuid;
  IF o.status <> 'sent' OR o.origin <> 'outlook' OR o.sent_at <> '2026-11-03T09:05:03Z'::timestamptz
     OR o.source_business_event_id <> ev1 OR o.supplier_name <> 'R&R Fencing' OR o.delivery_date <> '2026-11-12'
     OR o.body_text <> o.built_body_text OR o.to_emails <> ARRAY['sales@randrfencing.com.au']
     OR o.sent_to_emails <> ARRAY['sales@randrfencing.com.au'] OR o.sent_conversation_id <> 'CONV-VESNA'
     OR jsonb_array_length(o.order_lines) <> 1 OR o.is_main_supplier THEN
    RAISE EXCEPTION 'contract 1: order row wrong: %', row_to_json(o);
  END IF;
  SELECT count(*) INTO n FROM public.job_material_suppliers
   WHERE job_id = j_vesna AND supplier_id = s_rr AND position = 1 AND is_main_supplier = false;
  IF n <> 1 THEN RAISE EXCEPTION 'contract 1: box not made'; END IF;
  SELECT count(*) INTO n FROM public.job_events
   WHERE job_id = j_vesna AND event_type = 'dispatch_v2_outlook_order_recorded';
  IF n <> 1 THEN RAISE EXCEPTION 'contract 1: % job_events rows', n; END IF;

  -- 2. Idempotent: the same sent email again returns the same order and writes nothing.
  r2 := public.dispatch_v2_record_outlook_order(p);
  IF (r2->>'recorded')::boolean OR r2->>'reason' <> 'already_recorded' OR r2->>'order_id' <> r->>'order_id' THEN
    RAISE EXCEPTION 'contract 2: not idempotent: %', r2;
  END IF;
  SELECT count(*) INTO n FROM public.dispatch_supplier_order_emails WHERE job_id = j_vesna;
  IF n <> 1 THEN RAISE EXCEPTION 'contract 2: % order rows', n; END IF;
  SELECT count(*) INTO n FROM public.job_events WHERE job_id = j_vesna;
  IF n <> 1 THEN RAISE EXCEPTION 'contract 2: % job_events rows', n; END IF;

  -- 3. A second sent email to the same supplier (any of its Xero contacts) on that job is left alone.
  r2 := public.dispatch_v2_record_outlook_order(
    p || jsonb_build_object('source_business_event_id', ev2, 'supplier_id', s_rr2));
  IF (r2->>'recorded')::boolean OR r2->>'reason' <> 'dispatch_order_exists' THEN
    RAISE EXCEPTION 'contract 3: %', r2;
  END IF;

  -- 4. A job with a Dispatch draft for that supplier is left alone; a discarded one does not count.
  INSERT INTO public.dispatch_supplier_order_emails
    (org_id, job_id, supplier_id, supplier_name, status, subject, to_emails, body_text, built_body_text)
  VALUES (org, j_drafted, s_rr2, 'R&R FENCING', 'draft', 'Material Order Ref SWF-872587',
          ARRAY['sales@randrfencing.com.au'], 'x', 'x');
  r2 := public.dispatch_v2_record_outlook_order(
    p || jsonb_build_object('job_id', j_drafted, 'source_business_event_id', ev2));
  IF (r2->>'recorded')::boolean OR r2->>'reason' <> 'dispatch_order_exists' THEN
    RAISE EXCEPTION 'contract 4: %', r2;
  END IF;
  UPDATE public.dispatch_supplier_order_emails SET status = 'discarded' WHERE job_id = j_drafted;
  r2 := public.dispatch_v2_record_outlook_order(
    p || jsonb_build_object('job_id', j_drafted, 'source_business_event_id', ev2));
  IF NOT (r2->>'recorded')::boolean THEN RAISE EXCEPTION 'contract 4b: %', r2; END IF;

  -- 5. A box already there is used, never a second one.
  INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
  VALUES (org, j_boxed, s_rr, 'R&R Fencing', 3);
  r2 := public.dispatch_v2_record_outlook_order(
    p || jsonb_build_object('job_id', j_boxed, 'source_business_event_id', ev3));
  IF NOT (r2->>'recorded')::boolean OR (r2->>'box_created')::boolean THEN RAISE EXCEPTION 'contract 5: %', r2; END IF;
  SELECT count(*) INTO n FROM public.job_material_suppliers WHERE job_id = j_boxed;
  IF n <> 1 THEN RAISE EXCEPTION 'contract 5: % boxes', n; END IF;

  -- 6. An inactive supplier or an unknown job records nothing.
  r2 := public.dispatch_v2_record_outlook_order(
    p || jsonb_build_object('job_id', j_boxed, 'supplier_id', s_old, 'related_supplier_ids', jsonb_build_array(s_old),
                            'source_business_event_id', 'f2000000-0000-4000-8000-000000000024'));
  IF r2->>'reason' <> 'supplier_inactive' THEN RAISE EXCEPTION 'contract 6: %', r2; END IF;
  r2 := public.dispatch_v2_record_outlook_order(
    p || jsonb_build_object('job_id', 'f2000000-0000-4000-8000-000000000099',
                            'source_business_event_id', 'f2000000-0000-4000-8000-000000000025'));
  IF r2->>'reason' <> 'job_not_found' THEN RAISE EXCEPTION 'contract 6b: %', r2; END IF;
  SELECT count(*) INTO n FROM public.dispatch_supplier_order_emails WHERE job_id = j_boxed;
  IF n <> 1 THEN RAISE EXCEPTION 'contract 6: % order rows on the boxed job', n; END IF;

  -- 7. An Outlook order is always sent: it can never become a draft to edit or send again.
  BEGIN
    UPDATE public.dispatch_supplier_order_emails SET status = 'draft' WHERE id = (r->>'order_id')::uuid;
    RAISE EXCEPTION 'contract 7: an outlook order became a draft';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 8. Every row from before reads origin 'dispatch'.
  SELECT count(*) INTO n FROM public.dispatch_supplier_order_emails WHERE job_id = j_drafted AND origin = 'dispatch';
  IF n <> 1 THEN RAISE EXCEPTION 'contract 8: dispatch rows read %', n; END IF;
  -- 9. Only the service role may call it.
  IF has_function_privilege('anon', 'public.dispatch_v2_record_outlook_order(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.dispatch_v2_record_outlook_order(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.dispatch_v2_record_outlook_order(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract 9: wrong callers';
  END IF;
END $$;
ROLLBACK;
