-- Contract for 20261012090000_job_work_orders.sql: one live work order per
-- fencing / patio job, draft then approved (sealed) by the named approver,
-- labour stamped against it at invoice submit, backfill switched off.

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

  -- A second plain draft cannot be approved over the live one.
  INSERT INTO public.work_orders (org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'WO-WOC-A-1-X', 'job', 'draft', 10, '[{"description":"x"}]');
  BEGIN
    PERFORM public.approve_job_work_order(
      (SELECT id FROM public.work_orders WHERE wo_number = 'WO-WOC-A-1-X'),
      '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session');
    RAISE EXCEPTION 'contract: a non-revision draft must not replace a live approved work order';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  DELETE FROM public.work_orders WHERE wo_number = 'WO-WOC-A-1-X';

  -- 5. Revisions supersede in one step.
  INSERT INTO public.work_orders (org_id, job_id, wo_number, kind, status, agreed_labour_ex,
    scope_items, supersedes_work_order_id, origin)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'WO-WOC-A-1-R2', 'job', 'draft', 2400,
    '[{"description":"Install 26 m Colorbond"}]', v_wo, 'revision');
  v_row := public.approve_job_work_order(
    (SELECT id FROM public.work_orders WHERE wo_number = 'WO-WOC-A-1-R2'),
    '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session');
  IF (SELECT superseded_by_work_order_id FROM public.work_orders WHERE id = v_wo) IS DISTINCT FROM (v_row->>'id')::uuid
     OR public.job_live_work_order_id(v_job) IS DISTINCT FROM (v_row->>'id')::uuid
     OR (SELECT work_order_id FROM public.jobs WHERE id = v_job) IS DISTINCT FROM (v_row->>'id')::uuid THEN
    RAISE EXCEPTION 'contract: an approved revision must supersede the old one and become the live reference';
  END IF;

  INSERT INTO public.work_orders (org_id, job_id, wo_number, kind, status, agreed_labour_ex,
    scope_items, supersedes_work_order_id)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'WO-WOC-A-1-STALE', 'job', 'draft', 1,
    '[{"description":"x"}]', v_wo);
  BEGIN
    PERFORM public.approve_job_work_order(
      (SELECT id FROM public.work_orders WHERE wo_number = 'WO-WOC-A-1-STALE'),
      '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session');
    RAISE EXCEPTION 'contract: a revision of a superseded work order must not approve';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END $$;

-- 6. Labour links to the live approved work order at submit, never to a draft.
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

  IF (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id = v_inv AND job_work_order_id = v_wo) <> 1 THEN
    RAISE EXCEPTION 'contract: a submitted labour line must link to the live approved work order (and commission must not)';
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

  UPDATE public.trade_invoices SET status = 'ops-reject' WHERE id = v_draft_inv;
  IF (SELECT sum(amount_ex) FROM public.job_work_order_labour_lines WHERE work_order_id = v_wo AND counted) <> 400 THEN
    RAISE EXCEPTION 'contract: rejected invoices must not count in the labour view';
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
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'work_order_variation_emails_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'contract: both flags must be seeded off';
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
