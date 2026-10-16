-- Contract for 20261016120000_job_work_order_auto_issue.sql: a job work order
-- filled from the accepted quote goes to the trades with no human approval
-- (approved_via auto, no approver), only while job_work_order_auto_issue_v1 is
-- on, only for the draft the quote fill wrote that nobody has edited since,
-- and sealed exactly as an approval seals it. Human approval is unchanged.

BEGIN;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('9913309f-35ae-4a71-8e1f-f704ecc526ea', '00000000-0000-0000-0000-000000000001', 'Shaun', 'ops_manager'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'Trade', 'crew')
ON CONFLICT (id) DO NOTHING;

-- 1. Ships switched off; the door and the sweep are the service role's only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
                 WHERE flag_name = 'job_work_order_auto_issue_v1' AND enabled = false) THEN
    RAISE EXCEPTION 'contract: automatic issue must ship switched off';
  END IF;
  IF has_function_privilege('authenticated', 'public.auto_issue_job_work_order(uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.auto_issue_job_work_order(uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_job_work_order_auto_issue()', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the automatic issue door must not be callable by browser roles';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.auto_issue_job_work_order(uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: ops-api (service role) must be able to call the automatic issue door';
  END IF;
  -- Switched off, the sweep is a no-op: it never reaches net.http_post (absent
  -- here, so a call would fail).
  PERFORM public.trigger_job_work_order_auto_issue();
END $$;

-- 2. Drafts the quote fill wrote before this migration: stamped only when no
-- write landed after the fill's own event.
DO $$
BEGIN
  IF (SELECT wo.quote_filled_at FROM public.work_orders wo
      WHERE wo.job_id = 'a0a0a0a0-0000-4000-8000-000000000001' AND wo.kind = 'job') IS NULL THEN
    RAISE EXCEPTION 'contract: a draft untouched since its fill event must be stamped as the fill''s own';
  END IF;
  IF (SELECT wo.quote_filled_at FROM public.work_orders wo
      WHERE wo.job_id = 'a0a0a0a0-0000-4000-8000-000000000002' AND wo.kind = 'job') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: a draft saved after its fill event must not be stamped';
  END IF;
  IF EXISTS (SELECT 1 FROM public.work_orders wo
             WHERE wo.job_id IN ('a0a0a0a0-0000-4000-8000-000000000001', 'a0a0a0a0-0000-4000-8000-000000000002')
               AND wo.hand_edited_at IS NOT NULL) THEN
    RAISE EXCEPTION 'contract: the stamp of a prior fill must not read as a hand edit';
  END IF;
END $$;

-- 2b. Drafts written into by hand before this migration, with no lines, are
-- stamped as hand edits: the fill may not stamp them. The untouched opened
-- draft and the prior fill are not.
DO $$
DECLARE
  v_wo uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.work_orders wo
             WHERE wo.job_id IN ('a0a0a0a0-0000-4000-8000-000000000003',
                                 'a0a0a0a0-0000-4000-8000-000000000004',
                                 'a0a0a0a0-0000-4000-8000-000000000005')
               AND wo.kind = 'job' AND wo.hand_edited_at IS NULL) THEN
    RAISE EXCEPTION 'contract: a draft written into by hand before this migration must be stamped as a hand edit';
  END IF;
  IF (SELECT wo.hand_edited_at FROM public.work_orders wo
      WHERE wo.job_id = 'a0a0a0a0-0000-4000-8000-000000000006' AND wo.kind = 'job') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: an untouched opened draft must not read as a hand edit';
  END IF;
  SELECT id INTO v_wo FROM public.work_orders
    WHERE job_id = 'a0a0a0a0-0000-4000-8000-000000000003' AND kind = 'job';
  BEGIN
    UPDATE public.work_orders
      SET scope_items = '[{"description":"Install","source":"quote"}]', agreed_labour_ex = 600, quote_filled_at = now()
      WHERE id = v_wo;
    RAISE EXCEPTION 'contract: a draft edited by hand before this migration must not take the fill stamp';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 3. The stamps are the database's: the quote fill stamps an untouched draft
-- once; any other content change is a hand edit; a caller can set neither.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_typed uuid := gen_random_uuid();
  v_wo uuid;
  v_typed_wo uuid;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'WOA-STAMP-1'),
    (v_typed, '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'WOA-STAMP-2');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  SELECT id INTO v_typed_wo FROM public.work_orders WHERE job_id = v_typed AND kind = 'job';
  IF (SELECT quote_filled_at FROM public.work_orders WHERE id = v_wo) IS NOT NULL
     OR (SELECT hand_edited_at FROM public.work_orders WHERE id = v_wo) IS NOT NULL THEN
    RAISE EXCEPTION 'contract: a newly opened draft carries neither stamp';
  END IF;

  -- The fill: lines, agreed labour and the stamp in one write.
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install","qty":20,"unit":"m","source":"quote"}]',
        agreed_labour_ex = 800, quote_filled_at = now()
    WHERE id = v_wo;
  IF (SELECT quote_filled_at FROM public.work_orders WHERE id = v_wo) IS NULL
     OR (SELECT hand_edited_at FROM public.work_orders WHERE id = v_wo) IS NOT NULL THEN
    RAISE EXCEPTION 'contract: the quote fill of an untouched draft must stamp it and not read as a hand edit';
  END IF;
  BEGIN
    UPDATE public.work_orders SET quote_filled_at = now() + interval '1 minute' WHERE id = v_wo;
    RAISE EXCEPTION 'contract: the fill stamp must be written once only';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A person writes into the other draft first; the fill may not stamp it.
  UPDATE public.work_orders SET special_instructions = 'Dog on site' WHERE id = v_typed_wo;
  IF (SELECT hand_edited_at FROM public.work_orders WHERE id = v_typed_wo) IS NULL THEN
    RAISE EXCEPTION 'contract: a person writing into a draft must stamp it as edited by hand';
  END IF;
  BEGIN
    UPDATE public.work_orders
      SET scope_items = '[{"description":"Roof","source":"quote"}]', quote_filled_at = now()
      WHERE id = v_typed_wo;
    RAISE EXCEPTION 'contract: a draft edited by hand must not take the fill stamp';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.work_orders SET hand_edited_at = NULL WHERE id = v_typed_wo;
  IF (SELECT hand_edited_at FROM public.work_orders WHERE id = v_typed_wo) IS NULL THEN
    RAISE EXCEPTION 'contract: a caller must not clear the hand edit stamp';
  END IF;

  -- Editing the filled draft afterwards is a hand edit too.
  UPDATE public.work_orders SET agreed_labour_ex = 900 WHERE id = v_wo;
  IF (SELECT hand_edited_at FROM public.work_orders WHERE id = v_wo) IS NULL THEN
    RAISE EXCEPTION 'contract: editing a filled draft must stamp it as edited by hand';
  END IF;
END $$;

-- 4. Switched off, nothing is issued automatically: not by the door, not by a
-- direct write.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_wo uuid;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'scheduled', 'WOA-OFF-1');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install","source":"quote"}]', agreed_labour_ex = 500, quote_filled_at = now()
    WHERE id = v_wo;
  BEGIN
    PERFORM public.auto_issue_job_work_order(v_wo, (SELECT updated_at FROM public.work_orders WHERE id = v_wo));
    RAISE EXCEPTION 'contract: automatic issue must be refused while its flag is off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT status FROM public.work_orders WHERE id = v_wo) <> 'draft' THEN
    RAISE EXCEPTION 'contract: a refused automatic issue must seal nothing';
  END IF;
END $$;

UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_auto_issue_v1';

-- 5. Switched on: the filled, untouched draft is issued with no approver,
-- sealed with its content hash, the job pointed at it, and labour and trade
-- variations already on the job linked, as an approval does.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_wo uuid;
  v_inv uuid := gen_random_uuid();
  v_row jsonb;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'in_progress', 'WOA-ON-1');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install 20 m","qty":20,"unit":"m","source":"quote","needs_review":true,"flags":["labour_or_material_unknown"]}]',
        agreed_labour_ex = 1200, quote_filled_at = now()
    WHERE id = v_wo;

  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay) VALUES
    (v_inv, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'pending_ops_review',
     300, 0, 300, false, 0.12, 36, 300, 282);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_inv, v_job, 'labour', 300);
  INSERT INTO public.work_order_variations (org_id, job_id, trade_invoice_id, reported_by, description, amount_ex)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, v_inv, 'aaaaaaaa-0000-0000-0000-00000000000a', 'Extra post', 50);

  BEGIN
    PERFORM public.auto_issue_job_work_order(v_wo, (SELECT updated_at FROM public.work_orders WHERE id = v_wo) - interval '1 second');
    RAISE EXCEPTION 'contract: an issue carrying the stamp of an earlier read must be refused';
  EXCEPTION WHEN SQLSTATE 'WO409' THEN NULL;
  END;

  v_row := public.auto_issue_job_work_order(v_wo, (SELECT updated_at FROM public.work_orders WHERE id = v_wo));
  IF v_row->>'status' <> 'approved' OR v_row->>'approved_via' <> 'auto'
     OR v_row->>'approved_by' IS NOT NULL OR v_row->>'approved_at' IS NULL
     OR length(v_row->>'sealed_content_hash') <> 64 THEN
    RAISE EXCEPTION 'contract: an automatic issue must seal the draft with no approver: %', v_row;
  END IF;
  IF (SELECT work_order_id FROM public.jobs WHERE id = v_job) IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: the job must reference its issued work order';
  END IF;
  IF (SELECT job_work_order_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_inv) IS DISTINCT FROM v_wo
     OR (SELECT work_order_id FROM public.work_order_variations WHERE trade_invoice_id = v_inv) IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: labour and variations already on the job must link to the issued work order';
  END IF;
  IF public.job_live_work_order_id(v_job) IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: the issued work order is the job''s live work order';
  END IF;

  -- Sealed like any approved work order.
  BEGIN
    UPDATE public.work_orders SET agreed_labour_ex = 5000 WHERE id = v_wo;
    RAISE EXCEPTION 'contract: an issued work order must not be edited';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.work_orders WHERE id = v_wo;
    RAISE EXCEPTION 'contract: an issued work order must not be deleted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.auto_issue_job_work_order(v_wo, (SELECT updated_at FROM public.work_orders WHERE id = v_wo));
    RAISE EXCEPTION 'contract: an approved work order must never be issued again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 6. Never a draft someone edited by hand, nor one the fill did not write; and
-- never by a direct write that names itself automatic.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_plain uuid := gen_random_uuid();
  v_wo uuid;
  v_plain_wo uuid;
  v_pre_wo uuid;
  v_opened_wo uuid;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, '00000000-0000-0000-0000-000000000001', 'patio', 'scheduled', 'WOA-HAND-1'),
    (v_plain, '00000000-0000-0000-0000-000000000001', 'patio', 'scheduled', 'WOA-HAND-2');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  SELECT id INTO v_plain_wo FROM public.work_orders WHERE job_id = v_plain AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Roof","source":"quote"}]', agreed_labour_ex = 900, quote_filled_at = now()
    WHERE id = v_wo;
  UPDATE public.work_orders SET special_instructions = 'Use the side gate' WHERE id = v_wo;
  BEGIN
    PERFORM public.auto_issue_job_work_order(v_wo, (SELECT updated_at FROM public.work_orders WHERE id = v_wo));
    RAISE EXCEPTION 'contract: a draft edited by hand must not be issued automatically';
  EXCEPTION WHEN SQLSTATE 'WO423' THEN NULL;
  END;

  -- Typed by the office from scratch: no fill stamp.
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Roof"}]', agreed_labour_ex = 900
    WHERE id = v_plain_wo;
  BEGIN
    PERFORM public.auto_issue_job_work_order(v_plain_wo, (SELECT updated_at FROM public.work_orders WHERE id = v_plain_wo));
    RAISE EXCEPTION 'contract: a draft the quote fill did not write must not be issued automatically';
  EXCEPTION WHEN SQLSTATE 'WO423' THEN NULL;
  END;

  -- A direct write naming itself automatic, outside the door, is refused even
  -- with the flag on, and an automatic issue never names an approver.
  BEGIN
    UPDATE public.work_orders SET status = 'approved', approved_via = 'auto' WHERE id = v_plain_wo;
    RAISE EXCEPTION 'contract: a direct write must not issue automatically';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.work_orders SET approved_via = 'auto', approved_by = '9913309f-35ae-4a71-8e1f-f704ecc526ea'
      WHERE id = v_plain_wo;
    RAISE EXCEPTION 'contract: an automatic issue must never name an approver';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A draft edited by hand before this migration, filled afterwards: never
  -- issued automatically. The untouched opened draft, filled, is.
  SELECT id INTO v_pre_wo FROM public.work_orders
    WHERE job_id = 'a0a0a0a0-0000-4000-8000-000000000004' AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Roof","source":"quote"}]', agreed_labour_ex = 700
    WHERE id = v_pre_wo;
  BEGIN
    PERFORM public.auto_issue_job_work_order(v_pre_wo, (SELECT updated_at FROM public.work_orders WHERE id = v_pre_wo));
    RAISE EXCEPTION 'contract: a draft edited by hand before this migration must not be issued automatically';
  EXCEPTION WHEN SQLSTATE 'WO423' THEN NULL;
  END;
  SELECT id INTO v_opened_wo FROM public.work_orders
    WHERE job_id = 'a0a0a0a0-0000-4000-8000-000000000006' AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Roof","source":"quote"}]', agreed_labour_ex = 700, quote_filled_at = now()
    WHERE id = v_opened_wo;
  PERFORM public.auto_issue_job_work_order(v_opened_wo, (SELECT updated_at FROM public.work_orders WHERE id = v_opened_wo));
  IF (SELECT approved_via FROM public.work_orders WHERE id = v_opened_wo) IS DISTINCT FROM 'auto' THEN
    RAISE EXCEPTION 'contract: an untouched draft opened before this migration, filled from the quote, must be issued automatically';
  END IF;

  -- Both drafts still wait for the approver, whose approval works as before.
  IF (SELECT count(*) FROM public.work_orders WHERE id IN (v_wo, v_plain_wo) AND status = 'draft') <> 2 THEN
    RAISE EXCEPTION 'contract: refused automatic issues must seal nothing';
  END IF;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session',
    (SELECT updated_at FROM public.work_orders WHERE id = v_wo));
  IF (SELECT approved_via FROM public.work_orders WHERE id = v_wo) <> 'session'
     OR (SELECT approved_by FROM public.work_orders WHERE id = v_wo) <> '9913309f-35ae-4a71-8e1f-f704ecc526ea' THEN
    RAISE EXCEPTION 'contract: the approver''s own approval must be unchanged';
  END IF;
  -- And a human approval still needs the approver.
  BEGIN
    UPDATE public.work_orders SET status = 'approved', approved_via = 'session', approved_at = now()
      WHERE id = v_plain_wo;
    RAISE EXCEPTION 'contract: an approval naming nobody must be refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

ROLLBACK;
