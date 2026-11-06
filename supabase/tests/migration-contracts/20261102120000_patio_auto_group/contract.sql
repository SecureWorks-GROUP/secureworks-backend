-- WO-6. Nithin's flat office fees (Council Approval, Materials Ordered) never
-- block a group and a group never blocks them; install hours on a grouped
-- job are refused (since 20261106160000 earlier install hours billed in Xero
-- no longer stop a group opening; hours not billed yet still do). The weekly coverage view names each patio job's gap. Synthetic
-- records only; every fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  isaac uuid := 'f1020000-0000-4000-8000-00000000000a';
  ryan uuid := 'f1020000-0000-4000-8000-00000000000b';
  nithin uuid := 'f1020000-0000-4000-8000-00000000000c';
  jan uuid := 'f1020000-0000-4000-8000-00000000000d';
  j1 uuid := 'f1020000-0000-4000-8000-000000000101'; -- council fee, then grouped
  j2 uuid := 'f1020000-0000-4000-8000-000000000102'; -- Ryan paid by hours
  j3 uuid := 'f1020000-0000-4000-8000-000000000103'; -- no work order
  j4 uuid := 'f1020000-0000-4000-8000-000000000104'; -- Isaac and an admin only
  w1 uuid := 'f1020000-0000-4000-8000-000000000301';
  w2 uuid := 'f1020000-0000-4000-8000-000000000302';
  inv_n uuid; inv_r uuid; inv_n2 uuid; inv_r2 uuid;
  refused text;
  cov record;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','ops_manager'),(isaac,org,'Isaac Synthetic','lead_installer'),
    (ryan,org,'Ryan Synthetic','crew'),(nithin,org,'Nithin Synthetic','ops_manager'),(jan,org,'Jan Synthetic','admin')
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
    (j1,org,'patio','quoted','SYN-WO6-1'),(j2,org,'patio','quoted','SYN-WO6-2'),
    (j3,org,'patio','quoted','SYN-WO6-3'),(j4,org,'patio','quoted','SYN-WO6-4');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions) VALUES
    (w1,org,j1,'SYN-WO6-WO1','job','draft',2160,'[]','Synthetic WO-6 proof'),
    (w2,org,j2,'SYN-WO6-WO2','job','draft',2880,'[]','Synthetic WO-6 proof');
  UPDATE public.work_orders SET status='approved',approved_by=office WHERE id IN (w1,w2);
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status) VALUES
    (gen_random_uuid(),j1,isaac,'2026-11-17','scheduled'),(gen_random_uuid(),j1,ryan,'2026-11-18','scheduled'),
    (gen_random_uuid(),j1,nithin,'2026-11-18','scheduled'),
    (gen_random_uuid(),j2,isaac,'2026-11-10','scheduled'),(gen_random_uuid(),j2,ryan,'2026-11-10','scheduled'),
    (gen_random_uuid(),j3,isaac,'2026-11-12','scheduled'),(gen_random_uuid(),j3,ryan,'2026-11-12','scheduled'),
    (gen_random_uuid(),j4,isaac,'2026-11-12','scheduled'),(gen_random_uuid(),j4,jan,'2026-11-12','scheduled');

  -- Nithin's council fee on j1, Ryan's install hours on j2.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,nithin,'pending_acknowledgment',100,100,0,100,false,0.12,12,94,'SYN-WO6-N1') RETURNING id INTO inv_n;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,total_hours,hourly_rate,line_total_ex)
    VALUES(inv_n,j1,'labour','Council Approval',1,100,100);
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,ryan,'pending_acknowledgment',300,300,0,300,false,0.12,36,282,'SYN-WO6-R1') RETURNING id INTO inv_r;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,total_hours,hourly_rate,line_total_ex)
    VALUES(inv_r,j2,'labour','Plant posts and framing',7.5,40,300);

  -- 1. A council fee does not block a group.
  BEGIN
    INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,pay_basis)
      VALUES(org,j1,w1,'synthetic-wo6-token-1','all_in_12_v2');
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'office fee blocked a group: %', SQLERRM;
  END;

  -- 2. Since 20261106160000 install hours not billed yet hold a group; once
  -- billed in Xero they no longer block one: Ryan, paid by the hour, is left
  -- out of the crew. The bill and group are undone so the coverage read below
  -- sees j2 as before.
  refused := NULL;
  BEGIN
    INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,pay_basis)
      VALUES(org,j2,w2,'synthetic-wo6-token-2','all_in_12_v2');
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_open_blocked_by_hours_claim' THEN
    RAISE EXCEPTION 'unbilled hours did not hold a group on j2: %', refused;
  END IF;
  BEGIN
    UPDATE public.trade_invoices SET status='paid', xero_bill_id='SYN-WO6-BILL-R1', xero_bill_status='PAID' WHERE id = inv_r;
    INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,pay_basis)
      VALUES(org,j2,w2,'synthetic-wo6-token-2','all_in_12_v2');
    IF NOT public.group_work_order_paid_by_hours(j2, ryan)
       OR EXISTS (SELECT 1 FROM public.group_work_order_crew(ARRAY[j2]) c WHERE c.user_id = ryan) THEN
      RAISE EXCEPTION 'paid-by-hours crew member was not left out on j2';
    END IF;
    RAISE EXCEPTION 'wo6_undo_j2';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'wo6_undo_j2' THEN RAISE; END IF;
  END;

  -- 3. On the grouped job, Nithin's next fee goes through; hours do not.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,nithin,'pending_acknowledgment',200,200,0,200,false,0.12,24,188,'SYN-WO6-N2') RETURNING id INTO inv_n2;
  BEGIN
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,total_hours,hourly_rate,line_total_ex)
      VALUES(inv_n2,j1,'labour','Council Approval (Job Complete)',1,100,100),
            (inv_n2,j1,'labour','  materials ordered',1,100,100);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'a group blocked an office fee: %', SQLERRM;
  END;
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,ryan,'pending_acknowledgment',320,320,0,320,false,0.12,38.40,300.80,'SYN-WO6-R2') RETURNING id INTO inv_r2;
  refused := NULL;
  BEGIN
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,total_hours,hourly_rate,line_total_ex)
      VALUES(inv_r2,j1,'labour','Patio install, council approval chased',8,40,320);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'work_order_claim_blocked_by_group_share' THEN
    RAISE EXCEPTION 'hours on a grouped job were not refused: %', refused;
  END IF;

  -- 4. The helper: labour with the fee wording at the start only.
  IF NOT public.group_work_order_line_is_office_fee('labour','Council Approval + Materials Ordered')
     OR NOT public.group_work_order_line_is_office_fee('Labour','Council Approval Process')
     OR public.group_work_order_line_is_office_fee('work order','Council Approval')
     OR public.group_work_order_line_is_office_fee('labour','Patio install, council approval chased')
     OR public.group_work_order_line_is_office_fee('labour',NULL)
     OR public.group_work_order_line_is_office_fee('labour','Council approvals and framing') THEN
    RAISE EXCEPTION 'office fee helper wrong';
  END IF;

  -- 5. Weekly coverage.
  SELECT * INTO cov FROM public.v_patio_group_coverage WHERE job_id=j1;
  IF NOT FOUND OR cov.crew_count <> 3 OR cov.week_start <> '2026-11-16' OR NOT cov.covered OR cov.reason <> 'covered' THEN
    RAISE EXCEPTION 'coverage j1 wrong: %', row_to_json(cov);
  END IF;
  SELECT * INTO cov FROM public.v_patio_group_coverage WHERE job_id=j2;
  IF NOT FOUND OR cov.covered OR cov.reason <> 'crew_paid_by_hours_already' OR NOT cov.priced_work_order THEN
    RAISE EXCEPTION 'coverage j2 wrong: %', row_to_json(cov);
  END IF;
  SELECT * INTO cov FROM public.v_patio_group_coverage WHERE job_id=j3;
  IF NOT FOUND OR cov.covered OR cov.reason <> 'no_work_order' THEN
    RAISE EXCEPTION 'coverage j3 wrong: %', row_to_json(cov);
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_patio_group_coverage WHERE job_id=j4) THEN
    RAISE EXCEPTION 'coverage counted an office admin as crew';
  END IF;

  -- 6. The switch is added off; the view is service role only.
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name='group_work_order_auto_patio_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'auto patio flag missing or on';
  END IF;
  IF has_table_privilege('anon','public.v_patio_group_coverage','SELECT')
     OR has_table_privilege('authenticated','public.v_patio_group_coverage','SELECT')
     OR NOT has_table_privilege('service_role','public.v_patio_group_coverage','SELECT') THEN
    RAISE EXCEPTION 'coverage grants wrong';
  END IF;
END $$;
ROLLBACK;
