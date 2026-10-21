-- Contract for 20261021143000_job_work_order_crew_invoices.sql.
-- Every switch ships off. A make-safe job opens a blank work order only while
-- job_work_order_all_types_v1 is on. The 30-day preview selects open jobs by
-- real activity (an assignment, a time entry, an invoice line, or a status
-- change), never by jobs.updated_at alone. Draft work orders
-- stamp a crew line only while crew_invoice_on_job_work_order_v1 is on.
-- Office review starts only on insert, and only while its switch is on.

-- This statement stays outside the transaction so the break proof, which
-- commits the switch on, fails here and nowhere else.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'job_work_order_all_types_v1' AND enabled IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'contract: job work orders for every job type must ship switched off';
  END IF;
END $$;

BEGIN;

DO $$
DECLARE
  v_name text;
  v_flags text[] := ARRAY[
    'job_work_order_active_backfill_v1',
    'job_work_order_office_fill_v1',
    'crew_invoice_on_job_work_order_v1',
    'crew_invoice_line_office_review_v1',
    'crew_invoice_requires_job_work_order_v1',
    'retire_crew_work_orders_v1'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_flags LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.feature_flags
      WHERE flag_name = v_name AND enabled IS NOT TRUE
    ) THEN
      RAISE EXCEPTION 'contract: % must exist and ship switched off', v_name;
    END IF;
  END LOOP;
  IF (
    SELECT backup_approver_user_ids FROM public.work_order_settings WHERE id = 1
  ) IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'contract: backup approvers must ship empty';
  END IF;
  IF NOT ('processing' = ANY (public.job_work_order_open_statuses())) THEN
    RAISE EXCEPTION 'contract: processing must stay an open work-order status';
  END IF;
END $$;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'Crew', 'crew')
ON CONFLICT (id) DO NOTHING;

-- 1. Flag off: a make-safe still cannot open a work order. Turning the flag
-- on does not go back and open one that is already open.
DO $$
DECLARE
  v_safe uuid := gen_random_uuid();
BEGIN
  BEGIN
    PERFORM public.ensure_job_work_order_draft(v_safe, 'manual');
    RAISE EXCEPTION 'contract: ensure must refuse a missing job before the type rule';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;

  INSERT INTO public.jobs (id, org_id, type, status, job_number, updated_at)
  VALUES (v_safe, '00000000-0000-0000-0000-000000000001', 'makesafe', 'scheduled', 'JWOCI-OFF-1', now());
  IF EXISTS (SELECT 1 FROM public.work_orders WHERE job_id = v_safe AND kind = 'job') THEN
    RAISE EXCEPTION 'contract: a make-safe job must not open a work order while the switch is off';
  END IF;
  BEGIN
    PERFORM public.ensure_job_work_order_draft(v_safe, 'manual');
    RAISE EXCEPTION 'contract: ensure must still refuse a make-safe job while the switch is off';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%fencing%' OR SQLERRM NOT LIKE '%patio%' THEN
      RAISE EXCEPTION 'contract: the refusal must still name fencing and patio (%).', SQLERRM;
    END IF;
  END;

  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_all_types_v1';
  IF EXISTS (SELECT 1 FROM public.work_orders WHERE job_id = v_safe AND kind = 'job') THEN
    RAISE EXCEPTION 'contract: turning the switch on must not open a work order for a job that is already open';
  END IF;
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_work_order_all_types_v1';
END $$;

-- 2. Preview: real activity inside 30 days, no job work order, open status.
-- jobs.updated_at alone does not qualify. A processing row is inserted only
-- when this database allows that status.
DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_crew uuid := 'aaaaaaaa-0000-0000-0000-0000000000c1';
  v_now uuid := gen_random_uuid();
  v_edge uuid := gen_random_uuid();
  v_stale uuid := gen_random_uuid();
  v_done uuid := gen_random_uuid();
  v_draft uuid := gen_random_uuid();
  v_quoted uuid := gen_random_uuid();
  v_fence uuid := gen_random_uuid();
  v_inv uuid := gen_random_uuid();
  v_invoice uuid := gen_random_uuid();
  v_processing uuid := gen_random_uuid();
  v_processing_stale uuid := gen_random_uuid();
  v_asg_proc uuid := gen_random_uuid();
  v_asg_proc_stale uuid := gen_random_uuid();
  v_processing_ok boolean := false;
  v_result jsonb;
  v_missing uuid := gen_random_uuid();
  v_blank uuid := gen_random_uuid();
  v_type_check text;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number, updated_at) VALUES
    (v_now, v_org, 'makesafe', 'scheduled', 'JWOCI-MS-NOW', now() - interval '40 days'),
    (v_edge, v_org, 'makesafe', 'scheduled', 'JWOCI-MS-EDGE', now() - interval '40 days'),
    (v_stale, v_org, 'makesafe', 'scheduled', 'JWOCI-STALE', now()),
    (v_done, v_org, 'makesafe', 'complete', 'JWOCI-DONE', now()),
    (v_draft, v_org, 'makesafe', 'draft', 'JWOCI-DRAFT', now()),
    (v_quoted, v_org, 'makesafe', 'quoted', 'JWOCI-QUOTED', now()),
    (v_fence, v_org, 'fencing', 'accepted', 'JWOCI-FENCE', now()),
    (v_inv, v_org, 'makesafe', 'scheduled', 'JWOCI-INV', now() - interval '40 days');

  -- Scheduled today, created long ago: the date is the only signal.
  INSERT INTO public.job_assignments (id, job_id, user_id, role, scheduled_date, created_at) VALUES
    (gen_random_uuid(), v_now, v_crew, 'lead_installer', current_date, now() - interval '40 days'),
    (gen_random_uuid(), v_done, v_crew, 'lead_installer', current_date, now()),
    (gen_random_uuid(), v_draft, v_crew, 'lead_installer', current_date, now()),
    (gen_random_uuid(), v_quoted, v_crew, 'lead_installer', current_date, now()),
    (gen_random_uuid(), v_fence, v_crew, 'lead_installer', current_date, now());

  INSERT INTO public.job_events (job_id, event_type, detail_json, created_at)
  VALUES (v_edge, 'status_changed', '{}'::jsonb, now() - interval '30 days');

  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay)
  VALUES (v_invoice, v_org, v_crew, 'pending_acknowledgment', 10, 0, 10, false, 0.12, 1.2, 10, 9.4);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_invoice, v_inv, 'labour', 10);

  BEGIN
    INSERT INTO public.jobs (id, org_id, type, status, job_number, updated_at) VALUES
      (v_processing, v_org, 'makesafe', 'processing', 'JWOCI-PROC', now() - interval '40 days'),
      (v_processing_stale, v_org, 'makesafe', 'processing', 'JWOCI-PROC-STALE', now() - interval '40 days');
    INSERT INTO public.job_assignments (id, job_id, user_id, role, scheduled_date, created_at) VALUES
      (v_asg_proc, v_processing, v_crew, 'lead_installer', current_date - 40, now() - interval '40 days'),
      (v_asg_proc_stale, v_processing_stale, v_crew, 'lead_installer', current_date - 40, now() - interval '40 days');
    INSERT INTO public.job_assignment_logged_times (
      assignment_id, job_id, user_id, work_date, start_time, finish_time, hours, logged_at
    ) VALUES (
      v_asg_proc, v_processing, v_crew, current_date, '07:00', '15:00', 8,
      now() - interval '40 days'
    );
    v_processing_ok := true;
  EXCEPTION WHEN check_violation THEN
    v_processing_ok := false;
  END;

  IF to_regprocedure('public.apply_active_job_work_orders()') IS NOT NULL
     OR to_regprocedure('public.apply_active_job_work_orders(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'contract: apply must take the reviewed job ids';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.preview_active_job_work_orders() WHERE job_number = 'JWOCI-MS-NOW')
     OR NOT EXISTS (SELECT 1 FROM public.preview_active_job_work_orders() WHERE job_number = 'JWOCI-MS-EDGE')
     OR NOT EXISTS (SELECT 1 FROM public.preview_active_job_work_orders() WHERE job_number = 'JWOCI-INV') THEN
    RAISE EXCEPTION 'contract: an open job with recent activity and no work order must be previewed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.preview_active_job_work_orders()
    WHERE job_number IN ('JWOCI-STALE', 'JWOCI-DONE', 'JWOCI-DRAFT', 'JWOCI-QUOTED', 'JWOCI-FENCE')
  ) THEN
    RAISE EXCEPTION 'contract: a recent updated_at, a closed job, an unopened job and an already-covered job must stay out of the preview';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_orders WHERE job_id = v_fence AND kind = 'job' AND origin = 'job_approved') THEN
    RAISE EXCEPTION 'contract: an accepted fencing job must still open its own draft';
  END IF;
  IF v_processing_ok THEN
    IF NOT EXISTS (SELECT 1 FROM public.preview_active_job_work_orders() WHERE job_number = 'JWOCI-PROC')
       OR EXISTS (SELECT 1 FROM public.preview_active_job_work_orders() WHERE job_number = 'JWOCI-PROC-STALE') THEN
      RAISE EXCEPTION 'contract: a processing make-safe is previewed only from activity inside 30 days';
    END IF;
  END IF;

  BEGIN
    PERFORM public.apply_active_job_work_orders(ARRAY[v_now]);
    RAISE EXCEPTION 'contract: apply must refuse while either switch is off';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%job_work_order_all_types_v1%'
       OR SQLERRM NOT LIKE '%job_work_order_active_backfill_v1%' THEN
      RAISE EXCEPTION 'contract: the apply refusal must name both switches (%).', SQLERRM;
    END IF;
  END;

  UPDATE public.feature_flags SET enabled = true
  WHERE flag_name IN ('job_work_order_all_types_v1', 'job_work_order_active_backfill_v1');
  v_result := public.apply_active_job_work_orders(NULL);
  IF (v_result->>'opened')::int <> 0
     OR jsonb_array_length(v_result->'opened_ids') <> 0
     OR (v_result->>'skipped')::int <> 0
     OR jsonb_array_length(v_result->'skipped_jobs') <> 0 THEN
    RAISE EXCEPTION 'contract: a null id list must open nothing (%)', v_result;
  END IF;
  -- A blank type cannot be stored while jobs_type_check is on. Drop it only
  -- for this insert, put the type back, then restore the same check.
  SELECT pg_get_constraintdef(oid) INTO v_type_check
  FROM pg_constraint
  WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_type_check';
  IF v_type_check IS NULL THEN
    RAISE EXCEPTION 'contract: jobs_type_check must exist so a blank type can be forced';
  END IF;
  ALTER TABLE public.jobs DROP CONSTRAINT jobs_type_check;
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_blank, v_org, '   ', 'scheduled', 'JWOCI-BLANK');
  -- Apply only the ids this case reviewed. The shared database holds other
  -- contracts' open jobs, and apply must not open those. Every id is
  -- re-checked: activity, open status, a real type, and no job work order.
  v_result := public.apply_active_job_work_orders(ARRAY[
    v_now, v_edge, v_inv, v_done, v_stale, v_fence, v_missing, v_blank
  ]);
  IF (v_result->>'skipped')::int < 1
     OR NOT (v_result->'opened_ids' ? v_now::text) THEN
    RAISE EXCEPTION 'contract: apply must open the previewed ids and skip the closed one (%)', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result->'skipped_jobs') elem
    WHERE elem->>'job_id' = v_done::text AND elem->>'reason' = 'not_open'
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result->'skipped_jobs') elem
    WHERE elem->>'job_id' = v_stale::text AND elem->>'reason' = 'no_recent_activity'
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result->'skipped_jobs') elem
    WHERE elem->>'job_id' = v_missing::text AND elem->>'reason' = 'not_found'
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result->'skipped_jobs') elem
    WHERE elem->>'job_id' = v_blank::text AND elem->>'reason' = 'blank_type'
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result->'skipped_jobs') elem
    WHERE elem->>'job_id' = v_fence::text AND elem->>'reason' = 'already_has_work_order'
  ) THEN
    RAISE EXCEPTION 'contract: apply must name why each reviewed id was skipped (%)', v_result;
  END IF;
  IF v_result->'opened_ids' ? v_done::text
     OR v_result->'opened_ids' ? v_stale::text
     OR v_result->'opened_ids' ? v_missing::text
     OR v_result->'opened_ids' ? v_blank::text
     OR v_result->'opened_ids' ? v_fence::text THEN
    RAISE EXCEPTION 'contract: a skipped id must not be opened (%)', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.work_orders
    WHERE job_id = v_now AND kind = 'job' AND status = 'draft' AND origin = 'backfill'
      AND agreed_labour_ex IS NULL AND quote_filled_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.work_orders
    WHERE job_id = v_edge AND kind = 'job' AND origin = 'backfill' AND agreed_labour_ex IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.work_orders
    WHERE job_id = v_inv AND kind = 'job' AND origin = 'backfill' AND agreed_labour_ex IS NULL
  ) THEN
    RAISE EXCEPTION 'contract: apply must open a blank backfill draft for each previewed job';
  END IF;
  IF EXISTS (SELECT 1 FROM public.work_orders WHERE job_id IN (v_stale, v_done, v_draft, v_quoted, v_blank) AND kind = 'job') THEN
    RAISE EXCEPTION 'contract: apply must not open a work order the preview excluded';
  END IF;
  IF (SELECT count(*) FROM public.work_orders WHERE job_id = v_fence AND kind = 'job') <> 1
     OR (SELECT origin FROM public.work_orders WHERE job_id = v_fence AND kind = 'job') <> 'job_approved' THEN
    RAISE EXCEPTION 'contract: apply must leave the fencing job on the draft it already had';
  END IF;

  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN ('job_work_order_all_types_v1', 'job_work_order_active_backfill_v1');
  -- The type goes back only after the all-types switch is off. Restoring it
  -- while that switch is on would open a work order for this blank row.
  UPDATE public.jobs SET type = 'makesafe' WHERE id = v_blank;
  EXECUTE 'ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check ' || v_type_check;
END $$;

-- 3. Fencing still needs a scope. Another type may be approved on the
-- labour allowance alone. Marnin approves only while the office switch is on.
DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_shaun uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  v_marnin uuid := '706c5258-70dd-483a-b36c-af6864b24498';
  v_fence uuid := gen_random_uuid();
  v_safe uuid := gen_random_uuid();
  v_backup uuid := gen_random_uuid();
  v_wo uuid;
  v_seen timestamptz;
BEGIN
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_all_types_v1';

  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_fence, v_org, 'fencing', 'accepted', 'JWOCI-SCOPE-F'),
    (v_safe, v_org, 'makesafe', 'scheduled', 'JWOCI-SCOPE-M'),
    (v_backup, v_org, 'repair', 'scheduled', 'JWOCI-SCOPE-R');

  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_fence AND kind = 'job';
  UPDATE public.work_orders SET agreed_labour_ex = 400 WHERE id = v_wo;
  SELECT updated_at INTO v_seen FROM public.work_orders WHERE id = v_wo;
  BEGIN
    PERFORM public.approve_job_work_order(v_wo, v_shaun, 'session', v_seen);
    RAISE EXCEPTION 'contract: a fencing draft with no scope must not be approved';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%add the scope before approving%' THEN
      RAISE EXCEPTION 'contract: fencing refusal must ask for the scope (%).', SQLERRM;
    END IF;
  END;

  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_safe AND kind = 'job' AND origin = 'job_approved';
  IF v_wo IS NULL OR (SELECT agreed_labour_ex FROM public.work_orders WHERE id = v_wo) IS NOT NULL THEN
    RAISE EXCEPTION 'contract: the switch must open one blank make-safe draft';
  END IF;
  UPDATE public.work_orders SET agreed_labour_ex = 250 WHERE id = v_wo;
  SELECT updated_at INTO v_seen FROM public.work_orders WHERE id = v_wo;
  PERFORM public.approve_job_work_order(v_wo, v_shaun, 'session', v_seen);
  IF (SELECT status FROM public.work_orders WHERE id = v_wo) <> 'approved' THEN
    RAISE EXCEPTION 'contract: Shaun must be able to approve a make-safe draft on its labour allowance';
  END IF;

  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_backup AND kind = 'job';
  UPDATE public.work_orders SET agreed_labour_ex = 180 WHERE id = v_wo;
  SELECT updated_at INTO v_seen FROM public.work_orders WHERE id = v_wo;
  BEGIN
    PERFORM public.approve_job_work_order(v_wo, v_marnin, 'session', v_seen);
    RAISE EXCEPTION 'contract: Marnin must not approve while the office switch is off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_office_fill_v1';
  SELECT updated_at INTO v_seen FROM public.work_orders WHERE id = v_wo;
  BEGIN
    PERFORM public.approve_job_work_order(v_wo, v_marnin, 'session', v_seen);
    RAISE EXCEPTION 'contract: an empty backup list must not let Marnin approve';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.work_order_settings
    SET backup_approver_user_ids = ARRAY[v_marnin]
    WHERE id = 1;
  SELECT updated_at INTO v_seen FROM public.work_orders WHERE id = v_wo;
  PERFORM public.approve_job_work_order(v_wo, v_marnin, 'session', v_seen);
  IF (SELECT status FROM public.work_orders WHERE id = v_wo) <> 'approved'
     OR (SELECT approved_by FROM public.work_orders WHERE id = v_wo) IS DISTINCT FROM v_marnin THEN
    RAISE EXCEPTION 'contract: Marnin must approve once the office switch is on';
  END IF;

  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN ('job_work_order_all_types_v1', 'job_work_order_office_fill_v1');
END $$;

-- 4. Stamp and review. Review is insert-only. A later submit does not start it.
DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_trade uuid := 'aaaaaaaa-0000-0000-0000-0000000000c1';
  v_job uuid := gen_random_uuid();
  v_wo uuid;
  v_billed uuid := gen_random_uuid();
  v_held uuid := gen_random_uuid();
  v_plain uuid := gen_random_uuid();
  v_later uuid := gen_random_uuid();
BEGIN
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_all_types_v1';
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, v_org, 'makesafe', 'scheduled', 'JWOCI-LINE-1');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job' AND status = 'draft';
  IF v_wo IS NULL THEN
    RAISE EXCEPTION 'contract: the line fixture needs its blank draft';
  END IF;
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_work_order_all_types_v1';

  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay) VALUES
    (v_billed, v_org, v_trade, 'pending_acknowledgment', 100, 0, 100, false, 0.12, 12, 100, 94),
    (v_held, v_org, v_trade, 'pending_acknowledgment', 40, 0, 40, false, 0.12, 4.8, 40, 37.6),
    (v_plain, v_org, v_trade, 'pending_acknowledgment', 20, 0, 20, false, 0.12, 2.4, 20, 18.8),
    (v_later, v_org, v_trade, 'draft', 30, 0, 30, false, 0.12, 3.6, 30, 28.2);

  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_billed, v_job, 'labour', 100);
  IF EXISTS (
    SELECT 1 FROM public.trade_invoice_lines
    WHERE trade_invoice_id = v_billed AND job_work_order_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'contract: a draft work order must not stamp a line while the stamp switch is off';
  END IF;

  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'crew_invoice_on_job_work_order_v1';
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_billed, v_job, 'labour', 50);
  IF NOT EXISTS (
    SELECT 1 FROM public.trade_invoice_lines
    WHERE trade_invoice_id = v_billed AND job_id = v_job AND line_total_ex = 50
      AND job_work_order_id = v_wo AND source_work_order_id IS NULL
  ) THEN
    RAISE EXCEPTION 'contract: the stamp switch must name the draft on job_work_order_id only';
  END IF;

  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'crew_invoice_line_office_review_v1';
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_held, NULL, 'Travel', 40);
  IF (SELECT office_review_status FROM public.trade_invoice_lines WHERE trade_invoice_id = v_held) <> 'awaiting' THEN
    RAISE EXCEPTION 'contract: a travel line with no job must still start awaiting review';
  END IF;
  IF (SELECT job_work_order_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_held) IS NOT NULL
     OR (SELECT source_work_order_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_held) IS NOT NULL THEN
    RAISE EXCEPTION 'contract: travel with no job must not be tied to a work order';
  END IF;

  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'crew_invoice_line_office_review_v1';
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_plain, v_job, 'labour', 20);
  IF (SELECT office_review_status FROM public.trade_invoice_lines WHERE trade_invoice_id = v_plain) IS NOT NULL THEN
    RAISE EXCEPTION 'contract: review must stay unset while its switch is off';
  END IF;

  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_later, v_job, 'labour', 30);
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'crew_invoice_line_office_review_v1';
  UPDATE public.trade_invoices SET status = 'pending_acknowledgment' WHERE id = v_later;
  IF (SELECT office_review_status FROM public.trade_invoice_lines WHERE trade_invoice_id = v_later) IS NOT NULL THEN
    RAISE EXCEPTION 'contract: submitting an invoice must not start a review that was off at insert';
  END IF;
  IF (SELECT job_work_order_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_later) IS DISTINCT FROM v_wo THEN
    RAISE EXCEPTION 'contract: submitting an invoice must still stamp the draft work order';
  END IF;

  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN ('crew_invoice_on_job_work_order_v1', 'crew_invoice_line_office_review_v1');
END $$;

-- An unreadable review switch holds the line. Renaming the flag table is
-- the failure; the handler must set awaiting, and the rename is put back
-- before this block can fail the rest of the contract.
DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_trade uuid := 'aaaaaaaa-0000-0000-0000-0000000000c1';
  v_inv uuid := gen_random_uuid();
  v_status text;
BEGIN
  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name = 'crew_invoice_line_office_review_v1';
  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay) VALUES
    (v_inv, v_org, v_trade, 'pending_acknowledgment', 10, 0, 10, false, 0.12, 1.2, 10, 9.4);
  ALTER TABLE public.feature_flags RENAME TO feature_flags_review_hidden;
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_inv, NULL, 'Travel', 10);
  SELECT office_review_status INTO v_status
  FROM public.trade_invoice_lines WHERE trade_invoice_id = v_inv;
  ALTER TABLE public.feature_flags_review_hidden RENAME TO feature_flags;
  IF v_status IS DISTINCT FROM 'awaiting' THEN
    RAISE EXCEPTION 'contract: an unreadable review switch must hold the line awaiting, not leave it unmarked (%)', v_status;
  END IF;
  UPDATE public.trade_invoice_lines
  SET office_review_status = 'approved'
  WHERE trade_invoice_id = v_inv;
END $$;

-- The down migration refuses while review is on or any line is held, and
-- proceeds once both are clear. Clear the fixture holds before this
-- transaction ends so a later down is not blocked by them.
DO $$
BEGIN
  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name = 'crew_invoice_line_office_review_v1';
  IF NOT EXISTS (
    SELECT 1 FROM public.trade_invoice_lines
    WHERE office_review_status IN ('awaiting', 'queried', 'rejected')
  ) THEN
    RAISE EXCEPTION 'contract: the review fixture must leave a held line for the rollback guard';
  END IF;
  BEGIN
    PERFORM public.job_work_order_crew_invoice_rollback_guard();
    RAISE EXCEPTION 'contract: rollback must refuse while a line is held';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE '%held%' THEN
      RAISE EXCEPTION 'contract: the held-line refusal must say so (%)', SQLERRM;
    END IF;
  END;

  UPDATE public.feature_flags SET enabled = true
  WHERE flag_name = 'crew_invoice_line_office_review_v1';
  BEGIN
    PERFORM public.job_work_order_crew_invoice_rollback_guard();
    RAISE EXCEPTION 'contract: rollback must refuse while review is on';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE '%crew_invoice_line_office_review_v1%' THEN
      RAISE EXCEPTION 'contract: the review-on refusal must name the switch (%)', SQLERRM;
    END IF;
  END;

  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name = 'crew_invoice_line_office_review_v1';
  UPDATE public.trade_invoice_lines
  SET office_review_status = 'approved'
  WHERE office_review_status IN ('awaiting', 'queried', 'rejected');
  PERFORM public.job_work_order_crew_invoice_rollback_guard();
END $$;

ROLLBACK;
