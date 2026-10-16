-- Contract for 20261016100000_customer_variation_xero_draft_reconcile.sql: a
-- variation's Xero draft record that is `unknown` (or stuck `creating`) can be
-- answered for by a named approver: released to `prepared`, or recorded as a
-- created draft. An answer always carries who gave it, how and when; a
-- recorded draft stays sealed.

BEGIN;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('9913309f-35ae-4a71-8e1f-f704ecc526ea', '00000000-0000-0000-0000-000000000001', 'Shaun', 'ops_manager')
ON CONFLICT (id) DO NOTHING;
UPDATE public.work_order_settings SET approver_user_ids = ARRAY['9913309f-35ae-4a71-8e1f-f704ecc526ea']::uuid[] WHERE id = 1;

CREATE TEMP TABLE rc_fixture (job_id uuid, variation_id uuid) ON COMMIT DROP;
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_wo uuid;
  v_stamp timestamptz;
  v_var uuid;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'RC-F-1');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install fence","qty":10,"unit":"m"}]'::jsonb, agreed_labour_ex = 500
    WHERE id = v_wo
    RETURNING updated_at INTO v_stamp;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session', v_stamp);
  INSERT INTO public.work_order_customer_variations (org_id, job_id, description, tasks, trade_allocation_ex, customer_price_ex, created_by)
  VALUES ('00000000-0000-0000-0000-000000000001', v_job, 'Extra works',
          '[{"description":"Remove tree roots","hours":3}]'::jsonb, 135, 320, 'user:x')
  RETURNING id, updated_at INTO v_var, v_stamp;
  PERFORM public.approve_work_order_customer_variation(v_var, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session', v_stamp);
  INSERT INTO public.work_order_customer_variation_invoices (variation_id, job_id, line, prepared_by, status, xero_requested_by, xero_requested_at, failure)
  VALUES (v_var, v_job, '{"description":"Variation 1","quantity":1,"unit_price":320}'::jsonb, 'user:x',
          'unknown', 'user:x', now() - interval '1 hour', 'socket closed');
  INSERT INTO rc_fixture VALUES (v_job, v_var);
END $$;

-- 1. An answer names who gave it, how and when, or it is refused.
DO $$
DECLARE
  v_var uuid := (SELECT variation_id FROM rc_fixture);
BEGIN
  IF (SELECT reconciled_outcome FROM public.work_order_customer_variation_invoices WHERE variation_id = v_var) IS NOT NULL THEN
    RAISE EXCEPTION 'contract: a record nobody answered for carries no answer';
  END IF;
  BEGIN
    UPDATE public.work_order_customer_variation_invoices
      SET status = 'prepared', reconciled_outcome = 'no_draft'
      WHERE variation_id = v_var;
    RAISE EXCEPTION 'contract: an answer must name who gave it, how and when';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.work_order_customer_variation_invoices
      SET reconciled_outcome = 'maybe', reconciled_by = '9913309f-35ae-4a71-8e1f-f704ecc526ea',
          reconciled_via = 'session', reconciled_at = now()
      WHERE variation_id = v_var;
    RAISE EXCEPTION 'contract: an answer is draft_exists or no_draft';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.work_order_customer_variation_invoices
      SET reconciled_outcome = 'no_draft', reconciled_by = '9913309f-35ae-4a71-8e1f-f704ecc526ea',
          reconciled_via = 'phone', reconciled_at = now()
      WHERE variation_id = v_var;
    RAISE EXCEPTION 'contract: an answer is given from a session or the terminal';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 2. no_draft releases an unknown record to prepared, keeping the answer.
DO $$
DECLARE
  v_var uuid := (SELECT variation_id FROM rc_fixture);
BEGIN
  UPDATE public.work_order_customer_variation_invoices
    SET status = 'prepared', reconciled_outcome = 'no_draft',
        reconciled_by = '9913309f-35ae-4a71-8e1f-f704ecc526ea', reconciled_via = 'session',
        reconciled_at = now(), reconcile_note = 'Checked Xero: nothing there'
    WHERE variation_id = v_var AND status = 'unknown';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: an unknown record must be releasable to prepared';
  END IF;
END $$;

-- 3. draft_exists records the draft found in Xero, which is then sealed.
DO $$
DECLARE
  v_var uuid := (SELECT variation_id FROM rc_fixture);
BEGIN
  UPDATE public.work_order_customer_variation_invoices
    SET status = 'unknown' WHERE variation_id = v_var;
  UPDATE public.work_order_customer_variation_invoices
    SET status = 'xero_draft_created', xero_invoice_id = '77777777-7777-4777-8777-777777777777',
        invoice_number = 'INV-2001', xero_created_at = now(),
        reconciled_outcome = 'draft_exists', reconciled_by = '9913309f-35ae-4a71-8e1f-f704ecc526ea',
        reconciled_via = 'terminal', reconciled_at = now(), reconcile_note = NULL
    WHERE variation_id = v_var AND status = 'unknown';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: an unknown record must be recordable as a created draft';
  END IF;
  BEGIN
    UPDATE public.work_order_customer_variation_invoices
      SET status = 'prepared', reconciled_outcome = 'no_draft'
      WHERE variation_id = v_var;
    RAISE EXCEPTION 'contract: a recorded Xero draft must stay sealed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
