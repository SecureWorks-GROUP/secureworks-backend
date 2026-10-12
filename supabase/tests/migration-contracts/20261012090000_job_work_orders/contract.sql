-- Contract for 20261012090000_job_work_orders.sql: one work order per
-- fencing / patio job, draft then approved (sealed) by the named approver,
-- invoice lines stamped against it at submit and at approval (labour decided
-- by the cost lane), variations carried across a replaced draft invoice,
-- backfill switched off.

BEGIN;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('9913309f-35ae-4a71-8e1f-f704ecc526ea', '00000000-0000-0000-0000-000000000001', 'Shaun', 'ops_manager'),
  ('b353f39a-b3cc-495d-a016-50ebf4a8497d', '00000000-0000-0000-0000-000000000001', 'Hugo', 'ops_manager'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'Trade', 'crew')
ON CONFLICT (id) DO NOTHING;

-- 1. Existing crew work orders keep their shape; the approved status is job-only.
DO $$
DECLARE v_job uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'quoted', 'WOC-CREW-1');
  INSERT INTO public.work_orders (org_id, job_id, wo_number, status, scope_items)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'WO-111111', 'sent', '[]');
  IF (SELECT kind FROM public.work_orders WHERE wo_number = 'WO-111111') <> 'crew' THEN
    RAISE EXCEPTION 'contract: an existing-shape work order must default to kind crew';
  END IF;
  BEGIN
    UPDATE public.work_orders SET status = 'approved' WHERE wo_number = 'WO-111111';
    RAISE EXCEPTION 'contract: a crew work order must not take the approved status';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.work_orders (org_id, job_id, wo_number, kind, status, agreed_labour_ex,
      approved_at, approved_by, sealed_content_hash)
    VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'WO-X', 'job', 'approved', 1,
      now(), '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'x');
    RAISE EXCEPTION 'contract: a job work order must not be inserted already approved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 2. Approved fencing / patio jobs open one draft; other jobs open none.
DO $$
DECLARE
  v_fence uuid := gen_random_uuid();
  v_patio uuid := gen_random_uuid();
  v_safe uuid := gen_random_uuid();
  v_wo uuid;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_fence, '00000000-0000-0000-0000-000000000001', 'fencing', 'quoted', 'WOC-F-1'),
    (v_patio, '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'WOC-P-1'),
    (v_safe, '00000000-0000-0000-0000-000000000001', 'makesafe', 'scheduled', 'WOC-M-1');

  IF EXISTS (SELECT 1 FROM public.work_orders WHERE job_id IN (v_fence, v_safe) AND kind = 'job') THEN
    RAISE EXCEPTION 'contract: a quoted fencing job or a make-safe job must not get a job work order';
  END IF;
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_patio AND kind = 'job';
  IF v_wo IS NULL OR (SELECT status FROM public.work_orders WHERE id = v_wo) <> 'draft'
     OR (SELECT work_order_id FROM public.jobs WHERE id = v_patio) IS DISTINCT FROM v_wo
     OR (SELECT wo_number FROM public.work_orders WHERE id = v_wo) <> 'WO-WOC-P-1'
     OR (SELECT origin FROM public.work_orders WHERE id = v_wo) <> 'job_approved' THEN
    RAISE EXCEPTION 'contract: an accepted patio job must open one draft referenced by jobs.work_order_id';
  END IF;
  BEGIN
    UPDATE public.work_orders SET status = 'cancelled' WHERE id = v_wo;
    RAISE EXCEPTION 'contract: a job work order is a draft or approved, never cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE public.jobs SET status = 'scheduled' WHERE id = v_fence;
  UPDATE public.jobs SET status = 'in_progress' WHERE id = v_fence;
  IF (SELECT count(*) FROM public.work_orders WHERE job_id = v_fence AND kind = 'job') <> 1 THEN
    RAISE EXCEPTION 'contract: a fencing job entering an approved status must open exactly one draft';
  END IF;
END $$;

-- 3. Only the named approver approves, and only a complete draft.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_wo uuid;
  v_row jsonb;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'WOC-A-1');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';

  BEGIN
    PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session');
    RAISE EXCEPTION 'contract: a draft with no agreed labour must not approve';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE public.work_orders
    SET agreed_labour_ex = 1800, scope_items = '[{"description":"Install 20 m Colorbond","qty":20,"unit":"m","price":90}]'
    WHERE id = v_wo;

  BEGIN
    PERFORM public.approve_job_work_order(v_wo, 'b353f39a-b3cc-495d-a016-50ebf4a8497d', 'session');
    RAISE EXCEPTION 'contract: another ops_manager must not approve';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.work_orders SET status = 'approved', approved_by = 'b353f39a-b3cc-495d-a016-50ebf4a8497d',
      approved_at = now(), sealed_content_hash = 'forged' WHERE id = v_wo;
    RAISE EXCEPTION 'contract: a direct update must not approve for a non-approver';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  v_row := public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'terminal');
  IF v_row->>'status' <> 'approved' OR v_row->>'approved_via' <> 'terminal'
     OR length(v_row->>'sealed_content_hash') <> 64 THEN
    RAISE EXCEPTION 'contract: Shaun''s approval must seal the draft with a sha256 content hash';
  END IF;
  IF (SELECT work_order_id FROM public.jobs WHERE id = v_job) IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: the job must reference its approved work order';
  END IF;

  -- 4. Sealed.
  BEGIN
    UPDATE public.work_orders SET agreed_labour_ex = 5000 WHERE id = v_wo;
    RAISE EXCEPTION 'contract: an approved work order must not be edited';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.work_orders SET status = 'cancelled' WHERE id = v_wo;
    RAISE EXCEPTION 'contract: an approved work order must not change status';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.work_orders WHERE id = v_wo;
    RAISE EXCEPTION 'contract: an approved work order must not be deleted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.work_orders SET viewed_at = now() WHERE id = v_wo;

  -- One work order per job: no second draft beside the approved one.
  BEGIN
    INSERT INTO public.work_orders (org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items)
    VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'WO-WOC-A-1-X', 'job', 'draft', 10, '[{"description":"x"}]');
    RAISE EXCEPTION 'contract: a job must not hold a second job work order beside its approved one';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF public.ensure_job_work_order_draft(v_job, 'manual') IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: ensure must return the approved work order, not open another';
  END IF;
  BEGIN
    PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session');
    RAISE EXCEPTION 'contract: an approved work order must not be approved again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 5. The shared lists: which job statuses open a draft, and which trade
-- invoice statuses count as billed (ops-api/job_work_orders.ts mirrors the
-- second as JOB_WORK_ORDER_BILLED_INVOICE_STATUSES).
DO $$
BEGIN
  IF public.job_work_order_open_statuses() IS DISTINCT FROM ARRAY[
       'accepted', 'partially_accepted', 'approvals', 'deposit', 'awaiting_deposit',
       'processing', 'order_materials', 'awaiting_supplier', 'order_confirmed',
       'schedule_install', 'scheduled', 'in_progress', 'rectification']::text[] THEN
    RAISE EXCEPTION 'contract: job_work_order_open_statuses() changed';
  END IF;
  IF public.job_work_order_billed_invoice_statuses() IS DISTINCT FROM ARRAY[
       'pending_acknowledgment', 'queried', 'acknowledged', 'pending_ops_review',
       'approved', 'pushed_to_xero', 'paid']::text[] THEN
    RAISE EXCEPTION 'contract: job_work_order_billed_invoice_statuses() drifted from the list ops-api mirrors';
  END IF;
END $$;

-- 6. Invoice lines link to the approved work order at submit, never to a
-- draft. Only the labour cost lane (v_trade_charge_resolved) is labour.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_draft_job uuid := gen_random_uuid();
  v_wo uuid;
  v_inv uuid := gen_random_uuid();
  v_draft_inv uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, '00000000-0000-0000-0000-000000000001', 'patio', 'scheduled', 'WOC-L-1'),
    (v_draft_job, '00000000-0000-0000-0000-000000000001', 'patio', 'scheduled', 'WOC-L-2');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  UPDATE public.work_orders SET agreed_labour_ex = 1000, special_instructions = 'Insulated roof' WHERE id = v_wo;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session');

  -- The money split every new trade invoice carries (20260918120000).
  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay) VALUES
    (v_inv, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'pending_acknowledgment',
     400, 0, 400, false, 0.12, 48, 400, 376),
    (v_draft_inv, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'draft',
     250, 0, 250, false, 0.12, 30, 250, 235);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex) VALUES
    (v_inv, v_job, 'labour', 400),
    (v_inv, v_job, 'commission', 90),
    (v_inv, v_draft_job, 'labour', 300),
    (v_draft_inv, v_job, 'labour', 250);

  IF (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id = v_inv AND job_work_order_id = v_wo) <> 2 THEN
    RAISE EXCEPTION 'contract: every submitted line on the job must link to the approved work order';
  END IF;
  IF (SELECT COALESCE(sum(r.line_total_ex), 0)
      FROM public.v_trade_charge_resolved r
      JOIN public.trade_invoice_lines til ON til.id = r.line_id
      WHERE til.job_work_order_id = v_wo AND r.cost_lane = 'labour') <> 400 THEN
    RAISE EXCEPTION 'contract: commission linked to the work order must not be in the labour cost lane';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE job_id = v_draft_job AND job_work_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'contract: labour on a job whose work order is only a draft must not link';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id = v_draft_inv AND job_work_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'contract: a draft invoice must not link until it is submitted';
  END IF;

  UPDATE public.trade_invoices SET status = 'pending_acknowledgment' WHERE id = v_draft_inv;
  IF (SELECT job_work_order_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_draft_inv) IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: submitting a draft invoice must link its labour';
  END IF;
END $$;

-- 6b. A job invoiced before its work order is approved (the backfilled,
-- mid-install job): approving links the lines already billed on the job and
-- the variation already reported on it. A draft invoice, a rejected invoice
-- and another job's labour stay unlinked. Of the linked lines only the labour
-- cost lane is labour: 1,900 labour and 400 materials is 1,900 against the
-- agreed 2,000, not 2,300.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_wo uuid;
  v_paid uuid := gen_random_uuid();
  v_open uuid := gen_random_uuid();
  v_draft uuid := gen_random_uuid();
  v_rejected uuid := gen_random_uuid();
BEGIN
  ALTER TABLE public.jobs DISABLE TRIGGER trg_jobs_open_job_work_order;
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'in_progress', 'WOC-MID-1'),
    (v_other, '00000000-0000-0000-0000-000000000001', 'fencing', 'in_progress', 'WOC-MID-2');
  ALTER TABLE public.jobs ENABLE TRIGGER trg_jobs_open_job_work_order;

  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay) VALUES
    (v_paid, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'paid',
     600, 0, 600, false, 0.12, 72, 600, 564),
    (v_open, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'pending_ops_review',
     350, 0, 350, false, 0.12, 42, 350, 329),
    (v_draft, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'draft',
     100, 0, 100, false, 0.12, 12, 100, 94),
    (v_rejected, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'ops-reject',
     80, 0, 80, false, 0.12, 9.6, 80, 75.2);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex) VALUES
    (v_paid, v_job, 'labour', 1500),
    (v_paid, v_job, 'commission', 60),
    (v_paid, v_other, 'labour', 500),
    (v_open, v_job, 'labour', 400),
    (v_open, v_job, 'materials', 400),
    (v_draft, v_job, 'labour', 100),
    (v_rejected, v_job, 'labour', 80);
  IF EXISTS (SELECT 1 FROM public.trade_invoice_lines
             WHERE job_id IN (v_job, v_other) AND job_work_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'contract: labour on a job with no approved work order must not link at submit';
  END IF;
  INSERT INTO public.work_order_variations (org_id, job_id, trade_invoice_id, reported_by, description, amount_ex)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, v_open, 'aaaaaaaa-0000-0000-0000-00000000000a', 'Extra post', 50);

  v_wo := public.ensure_job_work_order_draft(v_job, 'backfill');
  UPDATE public.work_orders SET agreed_labour_ex = 2000, special_instructions = 'Finish the rear run' WHERE id = v_wo;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session');

  IF (SELECT COALESCE(sum(line_total_ex), 0) FROM public.trade_invoice_lines WHERE job_work_order_id = v_wo) <> 2360
     OR (SELECT count(*) FROM public.trade_invoice_lines WHERE job_work_order_id = v_wo) <> 4 THEN
    RAISE EXCEPTION 'contract: approving must link every line already billed on the job (1500 + 60 + 400 + 400), and nothing else';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_lines
             WHERE job_work_order_id IS NOT NULL
               AND (trade_invoice_id IN (v_draft, v_rejected) OR job_id = v_other)) THEN
    RAISE EXCEPTION 'contract: approving must not link a draft or rejected invoice, or another job';
  END IF;
  IF (SELECT COALESCE(sum(r.line_total_ex), 0)
      FROM public.v_trade_charge_resolved r
      JOIN public.trade_invoice_lines til ON til.id = r.line_id
      WHERE til.job_work_order_id = v_wo AND r.cost_lane = 'labour') <> 1900
     OR (SELECT r.cost_lane
         FROM public.v_trade_charge_resolved r
         JOIN public.trade_invoice_lines til ON til.id = r.line_id
         WHERE til.job_work_order_id = v_wo AND til.line_type = 'materials') <> 'materials' THEN
    RAISE EXCEPTION 'contract: labour against the work order must be 1900 (materials and commission are other lanes)';
  END IF;
  IF (SELECT work_order_id FROM public.work_order_variations WHERE job_id = v_job) IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: approving must link the variation already reported on the job';
  END IF;

  UPDATE public.trade_invoices SET status = 'pending_acknowledgment' WHERE id = v_draft;
  IF (SELECT job_work_order_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_draft) IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: a draft invoice submitted after approval must link its labour';
  END IF;
END $$;

-- 6c. Save a draft, report a variation on it, save again, submit. Each save
-- and the submit delete the draft row and insert a new invoice row; the
-- variation moves to the replacing row with its work order and its email
-- ledger. A variation whose job the replacing invoice no longer bills goes
-- with the draft.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_wo uuid;
  v_header jsonb;
  v_lines jsonb;
  v_draft uuid;
  v_saved uuid;
  v_submitted uuid := gen_random_uuid();
  v_variation uuid;
  v_emails uuid[];
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'scheduled', 'WOC-V-1'),
    (v_other, '00000000-0000-0000-0000-000000000001', 'fencing', 'scheduled', 'WOC-V-2');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  UPDATE public.work_orders SET agreed_labour_ex = 1000, special_instructions = 'Front run' WHERE id = v_wo;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session');

  v_header := jsonb_build_object(
    'org_id', '00000000-0000-0000-0000-000000000001', 'user_id', 'aaaaaaaa-0000-0000-0000-00000000000a',
    'week_start', '2026-10-05', 'week_end', '2026-10-11',
    'total_hours', 7.5, 'total_breaks_minutes', 0,
    'subtotal_ex', 300, 'gst', 0, 'total_inc', 300, 'gst_on', false,
    'super_rate', 0.12, 'super_amount', 36, 'gross_earned', 300, 'net_pay', 282,
    'invoice_source', 'hourly', 'status', 'draft');
  v_lines := jsonb_build_array(
    jsonb_build_object('job_id', v_job, 'job_number', 'WOC-V-1', 'line_type', 'labour',
      'description', 'Clocked labour', 'quantity', 5, 'unit', 'hr', 'unit_rate', 40,
      'total_hours', 5, 'hourly_rate', 40, 'line_total_ex', 200, 'line_position', 0),
    jsonb_build_object('job_id', v_other, 'job_number', 'WOC-V-2', 'line_type', 'labour',
      'description', 'Clocked labour', 'quantity', 2.5, 'unit', 'hr', 'unit_rate', 40,
      'total_hours', 2.5, 'hourly_rate', 40, 'line_total_ex', 100, 'line_position', 1));

  v_draft := public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);

  INSERT INTO public.work_order_variations (org_id, job_id, work_order_id, trade_invoice_id, reported_by, description, amount_ex)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, v_wo, v_draft, 'aaaaaaaa-0000-0000-0000-00000000000a', 'Extra post', 50)
  RETURNING id INTO v_variation;
  INSERT INTO public.work_order_variations (org_id, job_id, trade_invoice_id, reported_by, description)
  VALUES ('00000000-0000-0000-0000-000000000001', v_other, v_draft, 'aaaaaaaa-0000-0000-0000-00000000000a', 'Rock in the footing');
  INSERT INTO public.work_order_variation_emails (variation_id, recipient_role, recipient, subject, body_text, body_html, status, sent_at) VALUES
    (v_variation, 'finance', 'finance@secureworkswa.com.au', 's', 't', 'h', 'sent', now()),
    (v_variation, 'admin', 'admin@secureworkswa.com.au', 's', 't', 'h', 'sent', now());
  SELECT array_agg(id ORDER BY id) INTO v_emails
  FROM public.work_order_variation_emails WHERE variation_id = v_variation;

  v_saved := public.persist_weekly_trade_invoice_v1(v_header, v_lines, v_draft);
  IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = v_draft)
     OR (SELECT count(*) FROM public.work_order_variations WHERE trade_invoice_id = v_saved) <> 2 THEN
    RAISE EXCEPTION 'contract: saving a draft again must carry its variations to the replacing draft';
  END IF;

  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay)
  VALUES (v_submitted, '00000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'pending_acknowledgment', 200, 0, 200, false, 0.12, 24, 200, 188);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_submitted, v_job, 'labour', 200);
  PERFORM public.replace_trade_invoice_draft_v1(v_saved, v_submitted, 'aaaaaaaa-0000-0000-0000-00000000000a', ARRAY[]::uuid[]);

  IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = v_saved)
     OR NOT EXISTS (SELECT 1 FROM public.work_order_variations
                    WHERE id = v_variation AND trade_invoice_id = v_submitted
                      AND work_order_id = v_wo AND description = 'Extra post')
     OR (SELECT count(*) FROM public.work_order_variations WHERE job_id = v_job) <> 1 THEN
    RAISE EXCEPTION 'contract: a variation raised on a draft must be on the submitted invoice and still on the work order';
  END IF;
  IF (SELECT array_agg(id ORDER BY id) FROM public.work_order_variation_emails
      WHERE variation_id = v_variation AND status = 'sent') IS DISTINCT FROM v_emails THEN
    RAISE EXCEPTION 'contract: a carried variation must keep its email ledger, so nothing is sent again';
  END IF;
  IF EXISTS (SELECT 1 FROM public.work_order_variations WHERE job_id = v_other) THEN
    RAISE EXCEPTION 'contract: a variation whose job the replacing invoice no longer bills must go with the draft';
  END IF;
END $$;

-- 7. Backfill is a dry run unless the flag is on.
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_res jsonb;
BEGIN
  ALTER TABLE public.jobs DISABLE TRIGGER trg_jobs_open_job_work_order;
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'order_materials', 'WOC-B-1');
  ALTER TABLE public.jobs ENABLE TRIGGER trg_jobs_open_job_work_order;

  v_res := public.backfill_job_work_order_drafts(false);
  IF NOT (v_res->'job_ids' ? v_job::text) OR (v_res->>'opened')::int <> 0 THEN
    RAISE EXCEPTION 'contract: the dry run must list the open approved job and open nothing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.work_orders WHERE job_id = v_job) THEN
    RAISE EXCEPTION 'contract: the dry run must write nothing';
  END IF;
  BEGIN
    PERFORM public.backfill_job_work_order_drafts(true);
    RAISE EXCEPTION 'contract: the backfill must refuse while its flag is off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_work_order_backfill_v1') IS DISTINCT FROM false
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'work_order_variation_emails_v1') IS DISTINCT FROM false
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'work_order_terminal_approval_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'contract: all three flags must be seeded off';
  END IF;

  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_backfill_v1';
  v_res := public.backfill_job_work_order_drafts(true);
  IF NOT EXISTS (SELECT 1 FROM public.work_orders WHERE job_id = v_job AND kind = 'job'
                 AND status = 'draft' AND origin = 'backfill') THEN
    RAISE EXCEPTION 'contract: the switched-on backfill must open a draft';
  END IF;
  v_res := public.backfill_job_work_order_drafts(false);
  IF (v_res->>'candidates')::int <> 0 THEN
    RAISE EXCEPTION 'contract: the backfill must be idempotent';
  END IF;
END $$;

-- 8. Access: the new tables and doors are service-role only.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.work_order_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.work_order_variations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.work_order_variation_emails', 'SELECT')
     OR has_function_privilege('authenticated', 'public.approve_job_work_order(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.backfill_job_work_order_drafts(boolean)', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_orders'
                    AND policyname = 'work_orders_job_kind_hidden_from_clients' AND permissive = 'RESTRICTIVE'
                    AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'contract: job work order tables and functions must not be reachable by anon or authenticated';
  END IF;
END $$;

ROLLBACK;
