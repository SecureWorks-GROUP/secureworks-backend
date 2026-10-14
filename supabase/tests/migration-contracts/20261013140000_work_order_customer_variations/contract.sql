-- Contract for 20261013140000_work_order_customer_variations.sql: a customer
-- variation is a draft until a work order approver approves it as read; the
-- approval joins it to the job's approved work order as the next numbered
-- addendum and seals it; a draft can be cancelled; the customer invoice line
-- is prepared only from an approved variation; Xero stays switched off.

BEGIN;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('9913309f-35ae-4a71-8e1f-f704ecc526ea', '00000000-0000-0000-0000-000000000001', 'Shaun', 'ops_manager'),
  ('b353f39a-b3cc-495d-a016-50ebf4a8497d', '00000000-0000-0000-0000-000000000001', 'Esther', 'ops_manager')
ON CONFLICT (id) DO NOTHING;
UPDATE public.work_order_settings SET approver_user_ids = ARRAY['9913309f-35ae-4a71-8e1f-f704ecc526ea']::uuid[] WHERE id = 1;

-- A fencing job whose work order is opened by the job trigger, then filled and approved.
CREATE TEMP TABLE cv_fixture (job_id uuid, wo_id uuid, other_job uuid) ON COMMIT DROP;
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_wo uuid;
  v_stamp timestamptz;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'CV-F-1'),
    (v_other, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'CV-F-2');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install fence","qty":37.6,"unit":"m"}]'::jsonb, agreed_labour_ex = 1526
    WHERE id = v_wo
    RETURNING updated_at INTO v_stamp;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session', v_stamp);
  INSERT INTO cv_fixture VALUES (v_job, v_wo, v_other);
END $$;

-- 1. A variation is created as a draft, and every edit of a draft moves updated_at.
DO $$
DECLARE
  v_job uuid := (SELECT job_id FROM cv_fixture);
  v_id uuid;
  v_before timestamptz;
  v_after timestamptz;
BEGIN
  BEGIN
    INSERT INTO public.work_order_customer_variations (org_id, job_id, status, description, created_by)
    VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'approved', 'Sneaky', 'user:x');
    RAISE EXCEPTION 'contract: a customer variation must not be inserted already approved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.work_order_customer_variations (org_id, job_id, description, tasks, created_by)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'Extra works as discussed',
          '[{"description":"Remove tree roots","hours":3}]'::jsonb, 'user:b353f39a-b3cc-495d-a016-50ebf4a8497d')
  RETURNING id, updated_at INTO v_id, v_before;
  UPDATE public.work_order_customer_variations SET customer_price_ex = 320 WHERE id = v_id
    RETURNING updated_at INTO v_after;
  IF v_after <= v_before THEN
    RAISE EXCEPTION 'contract: an edit of a draft must move updated_at';
  END IF;
  BEGIN
    UPDATE public.work_order_customer_variations SET job_id = (SELECT other_job FROM cv_fixture) WHERE id = v_id;
    RAISE EXCEPTION 'contract: a customer variation must keep its job';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.work_order_customer_variations SET variation_number = 1 WHERE id = v_id;
    RAISE EXCEPTION 'contract: a draft must not take an addendum number';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 2. Approval: approver only, as read, complete, and only onto an approved work order.
DO $$
DECLARE
  v_job uuid := (SELECT job_id FROM cv_fixture);
  v_wo uuid := (SELECT wo_id FROM cv_fixture);
  v_id uuid;
  v_stamp timestamptz;
  v_out jsonb;
BEGIN
  SELECT id, updated_at INTO v_id, v_stamp FROM public.work_order_customer_variations
    WHERE job_id = v_job AND status = 'draft' LIMIT 1;

  BEGIN
    PERFORM public.approve_work_order_customer_variation(v_id, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session', v_stamp);
    RAISE EXCEPTION 'contract: a variation with no trade allocation must not be approved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.work_order_customer_variations SET trade_allocation_ex = 135 WHERE id = v_id;

  BEGIN
    PERFORM public.approve_work_order_customer_variation(v_id, 'b353f39a-b3cc-495d-a016-50ebf4a8497d', 'session',
      (SELECT updated_at FROM public.work_order_customer_variations WHERE id = v_id));
    RAISE EXCEPTION 'contract: only a work order approver approves a customer variation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.approve_work_order_customer_variation(v_id, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session', v_stamp);
    RAISE EXCEPTION 'contract: an approval must name the updated_at of the draft as read';
  EXCEPTION WHEN SQLSTATE 'WO409' THEN NULL;
  END;

  v_out := public.approve_work_order_customer_variation(v_id, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session',
    (SELECT updated_at FROM public.work_order_customer_variations WHERE id = v_id));
  IF v_out->>'status' <> 'approved' OR (v_out->>'work_order_id')::uuid IS DISTINCT FROM v_wo
     OR (v_out->>'variation_number')::int <> 1 OR v_out->>'sealed_content_hash' IS NULL
     OR v_out->>'approved_via' <> 'session' THEN
    RAISE EXCEPTION 'contract: approval must join the approved work order as Variation 1 and seal it: %', v_out;
  END IF;
  -- The work order itself is untouched by its addendum.
  IF (SELECT scope_items FROM public.work_orders WHERE id = v_wo) <> '[{"description":"Install fence","qty":37.6,"unit":"m"}]'::jsonb THEN
    RAISE EXCEPTION 'contract: an addendum must never change the sealed work order lines';
  END IF;
END $$;

-- 3. An approved variation is sealed: no edit, no cancel, no delete.
DO $$
DECLARE v_id uuid := (SELECT id FROM public.work_order_customer_variations
                      WHERE job_id = (SELECT job_id FROM cv_fixture) AND status = 'approved');
BEGIN
  BEGIN
    UPDATE public.work_order_customer_variations SET customer_price_ex = 1 WHERE id = v_id;
    RAISE EXCEPTION 'contract: an approved customer variation must be sealed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.work_order_customer_variations SET status = 'cancelled', cancelled_by = 'user:x' WHERE id = v_id;
    RAISE EXCEPTION 'contract: an approved customer variation must not be cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.work_order_customer_variations WHERE id = v_id;
    RAISE EXCEPTION 'contract: an approved customer variation must not be deleted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 4. The next approval on the work order is Variation 2; a task without hours never seals.
DO $$
DECLARE
  v_job uuid := (SELECT job_id FROM cv_fixture);
  v_id uuid;
  v_out jsonb;
BEGIN
  INSERT INTO public.work_order_customer_variations (org_id, job_id, description, tasks, trade_allocation_ex, customer_price_ex, created_by)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'More works',
          '[{"description":"Roots, one job"}]'::jsonb, 90, 200, 'user:b353f39a-b3cc-495d-a016-50ebf4a8497d')
  RETURNING id INTO v_id;
  BEGIN
    PERFORM public.approve_work_order_customer_variation(v_id, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session',
      (SELECT updated_at FROM public.work_order_customer_variations WHERE id = v_id));
    RAISE EXCEPTION 'contract: a task with no hours must not be approved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.work_order_customer_variations SET tasks = '[{"description":"Roots","hours":2}]'::jsonb WHERE id = v_id;
  v_out := public.approve_work_order_customer_variation(v_id, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session',
    (SELECT updated_at FROM public.work_order_customer_variations WHERE id = v_id));
  IF (v_out->>'variation_number')::int <> 2 THEN
    RAISE EXCEPTION 'contract: the second approved variation must be Variation 2: %', v_out;
  END IF;
END $$;

-- 5. With no approved work order the approval is refused (WO422); a draft can be cancelled.
DO $$
DECLARE
  v_other uuid := (SELECT other_job FROM cv_fixture);
  v_id uuid;
BEGIN
  INSERT INTO public.work_order_customer_variations (org_id, job_id, description, tasks, trade_allocation_ex, customer_price_ex, created_by)
  VALUES ('00000000-0000-0000-0000-000000000001', v_other, 'Early variation',
          '[{"description":"Roots","hours":2}]'::jsonb, 90, 200, 'user:b353f39a-b3cc-495d-a016-50ebf4a8497d')
  RETURNING id INTO v_id;
  BEGIN
    PERFORM public.approve_work_order_customer_variation(v_id, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session',
      (SELECT updated_at FROM public.work_order_customer_variations WHERE id = v_id));
    RAISE EXCEPTION 'contract: a variation must wait for the job''s approved work order';
  EXCEPTION WHEN SQLSTATE 'WO422' THEN NULL;
  END;
  UPDATE public.work_order_customer_variations SET status = 'cancelled', cancelled_by = 'user:b353f39a-b3cc-495d-a016-50ebf4a8497d'
    WHERE id = v_id;
  IF (SELECT cancelled_at FROM public.work_order_customer_variations WHERE id = v_id) IS NULL THEN
    RAISE EXCEPTION 'contract: a cancellation must stamp cancelled_at';
  END IF;
  BEGIN
    UPDATE public.work_order_customer_variations SET status = 'draft' WHERE id = v_id;
    RAISE EXCEPTION 'contract: a cancelled customer variation must stay cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 6. The invoice line: only from an approved variation of its job; a created Xero draft is final.
DO $$
DECLARE
  v_job uuid := (SELECT job_id FROM cv_fixture);
  v_approved uuid := (SELECT id FROM public.work_order_customer_variations WHERE job_id = v_job AND variation_number = 1);
  v_draft uuid;
BEGIN
  INSERT INTO public.work_order_customer_variations (org_id, job_id, description, created_by)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'Draft only', 'user:x')
  RETURNING id INTO v_draft;
  BEGIN
    INSERT INTO public.work_order_customer_variation_invoices (variation_id, job_id, line, prepared_by)
    VALUES (v_draft, v_job, '{"description":"x","quantity":1,"unit_price":1}'::jsonb, 'user:x');
    RAISE EXCEPTION 'contract: a draft variation must not have an invoice line';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.work_order_customer_variation_invoices (variation_id, job_id, line, prepared_by)
  VALUES (v_approved, v_job, '{"description":"Variation 1","quantity":1,"unit_price":320}'::jsonb, 'user:x');
  BEGIN
    INSERT INTO public.work_order_customer_variation_invoices (variation_id, job_id, line, prepared_by)
    VALUES (v_approved, v_job, '{"description":"again","quantity":1,"unit_price":320}'::jsonb, 'user:x');
    RAISE EXCEPTION 'contract: one invoice line per variation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE public.work_order_customer_variation_invoices
    SET status = 'xero_draft_created', xero_invoice_id = 'inv-1', xero_created_at = now()
    WHERE variation_id = v_approved;
  BEGIN
    UPDATE public.work_order_customer_variation_invoices SET status = 'prepared' WHERE variation_id = v_approved;
    RAISE EXCEPTION 'contract: a created Xero draft must not be reopened';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 7. Browser roles read nothing; Xero stays switched off.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.work_order_customer_variations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.work_order_customer_variations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.work_order_customer_variation_invoices', 'SELECT')
     OR has_function_privilege('authenticated', 'public.approve_work_order_customer_variation(uuid, uuid, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: customer variations must be hidden from browser roles';
  END IF;
  IF COALESCE((SELECT enabled FROM public.feature_flags WHERE flag_name = 'customer_variation_xero_draft_v1'), true) THEN
    RAISE EXCEPTION 'contract: the Xero draft flag must be seeded off';
  END IF;
END $$;

ROLLBACK;
