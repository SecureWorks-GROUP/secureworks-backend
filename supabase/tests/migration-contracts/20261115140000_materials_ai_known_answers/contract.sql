-- Contract for 20261115140000_materials_ai_known_answers. Fixture bills KA-01 to KA-15, each with the AI's
-- decision and the bookkeeper's answer, and the verdict each must read.

-- 0. Fixtures.
DO $$
DECLARE org uuid := gen_random_uuid();
        j1 uuid := 'a0000000-0000-4000-8000-000000000001'; j2 uuid := 'a0000000-0000-4000-8000-000000000002';
        j9 uuid := 'a0000000-0000-4000-8000-000000000009';
        ev1 uuid; ev2 uuid;
BEGIN
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, xero_contact_id, invoice_number, invoice_type, contact_name) VALUES
    (org, 'KA-01', 'C-PLANS', '5001', 'ACCPAY', 'KA Plans'),
    (org, 'KA-02', 'C-PLANS', '5002', 'ACCPAY', 'KA Plans'),
    (org, 'KA-03', 'C-STEEL', 'S-7003', 'ACCPAY', 'KA Steel'),
    (org, 'KA-04', 'C-STEEL', 'S-7004', 'ACCPAY', 'KA Steel'),
    (org, 'KA-05', 'C-FUEL', 'F-8005', 'ACCPAY', 'KA Fuel'),
    (org, 'KA-06', 'C-STEEL', 'S-7006', 'ACCPAY', 'KA Steel'),
    (org, 'KA-07', 'C-STEEL', 'S-7007', 'ACCPAY', 'KA Steel'),
    (org, 'KA-08', 'C-STEEL', 'S-7008', 'ACCPAY', 'KA Steel'),
    (org, 'KA-09', 'C-STEEL', 'S-7009', 'ACCPAY', 'KA Steel'),
    (org, 'KA-10', 'C-STEEL', 'S-7010', 'ACCPAY', 'KA Steel'),
    (org, 'KA-11', 'C-STEEL', 'S-7011', 'ACCPAY', 'KA Steel'),
    (org, 'KA-12', 'C-STEEL', 'S-7012', 'ACCPAY', 'KA Steel'),
    (org, 'KA-13', 'C-POSTS', '6013', 'ACCPAY', 'KA Posts'),
    (org, 'KA-14', 'C-STEEL', 'S-7014', 'ACCPAY', 'KA Steel'),
    (org, 'KA-15', 'C-STEEL', 'S-7015', 'ACCPAY', 'KA Steel'),
    (org, 'KA-16', 'C-OTHER', '6016', 'ACCPAY', 'KA Other');

  -- One email carrying two bills of the same supplier (KA-01, KA-02); another carrying KA-13 and a bill of a
  -- different supplier (KA-16): only the first makes a multi-bill email.
  INSERT INTO public.business_events (event_type) VALUES ('email_received') RETURNING id INTO ev1;
  INSERT INTO public.business_events (event_type) VALUES ('email_received') RETURNING id INTO ev2;
  INSERT INTO public.context_email_attachments (provider_message_id, attachment_key, business_event_id, file_name, status) VALUES
    ('email:ka-1', repeat('1', 64), ev1, 'Inv No 5001.pdf', 'skipped_kind'),
    ('email:ka-1', repeat('2', 64), ev1, 'Inv No 5002.pdf', 'skipped_kind'),
    ('email:ka-2', repeat('3', 64), ev2, 'Invoice 6013.pdf', 'skipped_kind'),
    ('email:ka-2', repeat('4', 64), ev2, 'Invoice 6016.pdf', 'skipped_kind');

  INSERT INTO public.v_bookkeeping_line_evidence_current (xero_invoice_id, xero_line_item_id, allocation, job_id, job_number, evidenced) VALUES
    ('KA-01', 'l1', 'job', j1, 'KA-J1', true), ('KA-01', 'l2', 'job', j1, 'KA-J1', true),
    ('KA-02', 'l1', 'job', j2, 'KA-J2', true),
    ('KA-03', 'l1', 'overhead', NULL, NULL, true),
    ('KA-04', 'l1', 'job', j1, 'KA-J1', true),
    ('KA-05', 'l1', 'not_job_cost', NULL, NULL, true), ('KA-05', 'l2', 'overhead', NULL, NULL, true),
    ('KA-06', 'l1', 'job', j1, 'KA-J1', true),
    ('KA-07', 'l1', 'job', j1, 'KA-J1', true), ('KA-07', 'l2', 'job', j2, 'KA-J2', true),
    ('KA-08', 'l1', 'job', j1, 'KA-J1', true), ('KA-08', 'l2', 'job', j1, 'KA-J1', false),
    ('KA-10', 'l1', 'job', j1, 'KA-J1', true),
    ('KA-11', 'l1', 'job', NULL, NULL, true),
    ('KA-12', 'l1', 'job', j1, 'KA-J1', true), ('KA-12', 'l2', 'overhead', NULL, NULL, true),
    ('KA-13', 'l1', 'job', j2, 'KA-J2', true),
    ('KA-14', 'l1', 'job', j2, 'KA-J2', true),
    ('KA-15', 'l1', 'job', j2, 'KA-J2', true);

  INSERT INTO public.materials_ai_placements
    (xero_invoice_id, invoice_number, contact_name, amount_ex, decision, job_id, job_number, confidence, reason, model,
     outcome, agreed_keys, held_at, created_at, undone_at, undone_by) VALUES
    ('KA-01', '5001', 'KA Plans', 100, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', ARRAY['ai_confidence','job_number'], NULL, now() - interval '3 days', NULL, NULL),
    ('KA-02', '5002', 'KA Plans', 100, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', NULL, NULL, now() - interval '3 days', NULL, NULL),
    ('KA-03', 'S-7003', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.800, 'r', 'm', 'held_for_check', ARRAY['ai_confidence'], now(), now() - interval '3 days', NULL, NULL),
    ('KA-04', 'S-7004', 'KA Steel', 50, 'not_job_related', NULL, NULL, 0.900, 'r', 'm', 'filed_not_job_related', ARRAY['ai_confidence'], NULL, now() - interval '3 days', NULL, NULL),
    ('KA-05', 'F-8005', 'KA Fuel', 20, 'not_job_related', NULL, NULL, 0.950, 'r', 'm', 'filed_not_job_related', ARRAY['ai_confidence'], NULL, now() - interval '3 days', NULL, NULL),
    ('KA-06', 'S-7006', 'KA Steel', 50, 'unsure', NULL, NULL, 0.300, 'r', 'm', 'left_for_person', NULL, NULL, now() - interval '3 days', NULL, NULL),
    ('KA-07', 'S-7007', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', NULL, NULL, now() - interval '3 days', NULL, NULL),
    ('KA-08', 'S-7008', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', NULL, NULL, now() - interval '3 days', NULL, NULL),
    ('KA-09', 'S-7009', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', NULL, NULL, now() - interval '3 days', NULL, NULL),
    -- KA-10: an older wrong answer, then a newer right one. The latest decides.
    ('KA-10', 'S-7010', 'KA Steel', 50, 'job', j9, 'KA-J9', 0.990, 'r', 'm', 'left_for_person', NULL, NULL, now() - interval '5 days', NULL, NULL),
    ('KA-10', 'S-7010', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', ARRAY['ai_confidence','job_number'], NULL, now() - interval '1 day', NULL, NULL),
    ('KA-11', 'S-7011', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', NULL, NULL, now() - interval '3 days', NULL, NULL),
    ('KA-12', 'S-7012', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', NULL, NULL, now() - interval '3 days', NULL, NULL),
    ('KA-13', '6013', 'KA Posts', 50, 'job', j2, 'KA-J2', 0.990, 'r', 'm', 'placed', NULL, NULL, now() - interval '3 days', NULL, NULL),
    -- KA-14: a job named at low confidence and left for a person, and wrong: counted wrong, not sure_and_wrong.
    ('KA-14', 'S-7014', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.600, 'r', 'm', 'left_for_person', NULL, NULL, now() - interval '3 days', NULL, NULL),
    -- KA-15: placed and then undone by a person. Still what the AI said.
    ('KA-15', 'S-7015', 'KA Steel', 50, 'job', j1, 'KA-J1', 0.990, 'r', 'm', 'placed', NULL, NULL, now() - interval '3 days', now(), 'person');
END $$;

-- 1. Grants and comments.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.v_materials_ai_known_answers', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_materials_ai_known_answers', 'SELECT')
     OR has_table_privilege('anon', 'public.v_materials_ai_accuracy_by_supplier', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_materials_ai_accuracy_by_supplier', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_materials_ai_known_answers', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_materials_ai_accuracy_by_supplier', 'SELECT') THEN
    RAISE EXCEPTION 'materials ai known answers contract: the views must be the service role''s only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.v_materials_ai_known_answers'::regclass
                   AND 'security_invoker=true' = ANY (c.reloptions))
     OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.v_materials_ai_accuracy_by_supplier'::regclass
                   AND 'security_invoker=true' = ANY (c.reloptions)) THEN
    RAISE EXCEPTION 'materials ai known answers contract: the views must run with the caller''s rights';
  END IF;
  IF obj_description('public.v_materials_ai_known_answers'::regclass, 'pg_class') NOT LIKE 'Materials AI known answers (20261115140000): %'
     OR obj_description('public.v_materials_ai_accuracy_by_supplier'::regclass, 'pg_class') NOT LIKE 'Materials AI known answers (20261115140000): %' THEN
    RAISE EXCEPTION 'materials ai known answers contract: the comments do not name the slice';
  END IF;
END $$;

-- 2. Each bill's answer and verdict.
DO $$
DECLARE r record; n int := 0;
BEGIN
  IF (SELECT count(*) FROM public.v_materials_ai_known_answers WHERE xero_invoice_id LIKE 'KA-%') <> 15 THEN
    RAISE EXCEPTION 'materials ai known answers contract: expected one row per decided bill (15), got %',
      (SELECT count(*) FROM public.v_materials_ai_known_answers WHERE xero_invoice_id LIKE 'KA-%');
  END IF;
  FOR r IN
    SELECT e.id, e.answer, e.verdict, e.rule, e.multi, e.undone, k.bookkeeper_answer, k.verdict AS got_verdict,
           k.rule AS got_rule, k.multi_bill_email, k.undone AS got_undone, k.xero_contact_id
      FROM (VALUES
        ('KA-01', 'job',           'agree',                'two_keys',        true,  false),
        ('KA-02', 'job',           'wrong_job',            'before_two_keys', true,  false),
        ('KA-03', 'not_job_cost',  'job_but_not_job_cost', 'two_keys',        false, false),
        ('KA-04', 'job',           'missed_job_cost',      'two_keys',        false, false),
        ('KA-05', 'not_job_cost',  'agree',                'two_keys',        false, false),
        ('KA-06', 'job',           'declined',             'before_two_keys', false, false),
        ('KA-07', 'split',         'no_answer',            'before_two_keys', false, false),
        ('KA-08', 'not_evidenced', 'no_answer',            'before_two_keys', false, false),
        ('KA-09', NULL,            'no_answer',            'before_two_keys', false, false),
        ('KA-10', 'job',           'agree',                'two_keys',        false, false),
        ('KA-11', 'not_evidenced', 'no_answer',            'before_two_keys', false, false),
        ('KA-12', 'split',         'no_answer',            'before_two_keys', false, false),
        ('KA-13', 'job',           'agree',                'before_two_keys', false, false),
        ('KA-14', 'job',           'wrong_job',            'before_two_keys', false, false),
        ('KA-15', 'job',           'wrong_job',            'before_two_keys', false, true)
      ) AS e(id, answer, verdict, rule, multi, undone)
      LEFT JOIN public.v_materials_ai_known_answers k ON k.xero_invoice_id = e.id
  LOOP
    n := n + 1;
    IF r.bookkeeper_answer IS DISTINCT FROM r.answer OR r.got_verdict IS DISTINCT FROM r.verdict
       OR r.got_rule IS DISTINCT FROM r.rule OR r.multi_bill_email IS DISTINCT FROM r.multi
       OR r.got_undone IS DISTINCT FROM r.undone THEN
      RAISE EXCEPTION '% verdict %, expected %: answer % (expected %), rule % (expected %), multi % (expected %), undone % (expected %)',
        r.id, r.got_verdict, r.verdict, r.bookkeeper_answer, r.answer, r.got_rule, r.rule, r.multi_bill_email, r.multi,
        r.got_undone, r.undone;
    END IF;
  END LOOP;
  IF (SELECT ai_job_number FROM public.v_materials_ai_known_answers WHERE xero_invoice_id = 'KA-10') <> 'KA-J1' THEN
    RAISE EXCEPTION 'KA-10: the latest decision must be read, not an older one';
  END IF;
  IF (SELECT bookkeeper_job_number FROM public.v_materials_ai_known_answers WHERE xero_invoice_id = 'KA-02') <> 'KA-J2'
     OR (SELECT bookkeeper_job_id FROM public.v_materials_ai_known_answers WHERE xero_invoice_id = 'KA-07') IS NOT NULL THEN
    RAISE EXCEPTION 'the bookkeeper''s job is named only when the answer is one job';
  END IF;
  IF (SELECT xero_contact_id FROM public.v_materials_ai_known_answers WHERE xero_invoice_id = 'KA-01') <> 'C-PLANS' THEN
    RAISE EXCEPTION 'KA-01: the supplier must be the bill''s Xero contact';
  END IF;
END $$;

-- 3. Counted per supplier and rule.
DO $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM public.v_materials_ai_accuracy_by_supplier WHERE xero_contact_id = 'C-STEEL' AND rule = 'before_two_keys';
  IF s.decided <> 8 OR s.checkable <> 3 OR s.agree <> 0 OR s.wrong_job <> 2 OR s.declined <> 1
     OR s.sure_and_wrong <> 1 OR s.placed_wrong <> 1 OR s.placed_agree <> 0 OR s.multi_bill_email <> 0 THEN
    RAISE EXCEPTION 'steel before two keys counted wrong: %', row_to_json(s);
  END IF;
  SELECT * INTO s FROM public.v_materials_ai_accuracy_by_supplier WHERE xero_contact_id = 'C-STEEL' AND rule = 'two_keys';
  IF s.decided <> 3 OR s.checkable <> 3 OR s.agree <> 1 OR s.job_but_not_job_cost <> 1 OR s.missed_job_cost <> 1
     OR s.sure_and_wrong <> 0 OR s.placed_agree <> 1 OR s.placed_wrong <> 0 THEN
    RAISE EXCEPTION 'steel two keys counted wrong: %', row_to_json(s);
  END IF;
  SELECT * INTO s FROM public.v_materials_ai_accuracy_by_supplier WHERE xero_contact_id = 'C-PLANS' AND rule = 'before_two_keys';
  IF s.decided <> 1 OR s.wrong_job <> 1 OR s.sure_and_wrong <> 1 OR s.multi_bill_email <> 1 OR s.placed_wrong <> 1 THEN
    RAISE EXCEPTION 'plans before two keys counted wrong: %', row_to_json(s);
  END IF;
  IF (SELECT count(*) FROM public.v_materials_ai_accuracy_by_supplier WHERE xero_contact_id IN ('C-PLANS', 'C-STEEL', 'C-FUEL', 'C-POSTS')) <> 6 THEN
    RAISE EXCEPTION 'expected six supplier and rule rows for the fixtures';
  END IF;
END $$;

-- 4. Read only: reading writes nothing.
DO $$
DECLARE before bigint := (SELECT count(*) FROM public.materials_ai_placements);
BEGIN
  PERFORM count(*) FROM public.v_materials_ai_accuracy_by_supplier;
  IF (SELECT count(*) FROM public.materials_ai_placements) <> before THEN
    RAISE EXCEPTION 'materials ai known answers contract: a read changed the audit table';
  END IF;
END $$;
