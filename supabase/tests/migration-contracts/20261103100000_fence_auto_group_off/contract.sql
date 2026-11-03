-- V8 fence groups, built switched off. The fence flag is added off; the
-- combined weekly view names each fencing job's gap, including quoted labour
-- outside the pool and a fence lead's fixed-price work-order claim; patio
-- rows read exactly as v_patio_group_coverage. Fixtures follow live records
-- read 3 Nov 2026 (SWF-261370, SWF-261459, SWF-26968 / SW-INV-A-261011-029).
-- Synthetic records only; every fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  alyx uuid := 'f1030000-0000-4000-8000-00000000000a';
  henry uuid := 'f1030000-0000-4000-8000-00000000000b'; -- ops_manager who installs
  sonny uuid := 'f1030000-0000-4000-8000-00000000000c';
  kim uuid := 'f1030000-0000-4000-8000-00000000000d';
  jan uuid := 'f1030000-0000-4000-8000-00000000000e';   -- office admin
  f1 uuid := 'f1030000-0000-4000-8000-000000000101'; -- SWF-261370 shape, grouped
  f2 uuid := 'f1030000-0000-4000-8000-000000000102'; -- SWF-261459 shape, labour outside pool
  f3 uuid := 'f1030000-0000-4000-8000-000000000103'; -- SWF-26968 shape, lead's work-order claim
  f4 uuid := 'f1030000-0000-4000-8000-000000000104'; -- crew billed hours
  f5 uuid := 'f1030000-0000-4000-8000-000000000105'; -- priced, 2 crew, no pay: what the switch would group
  f6 uuid := 'f1030000-0000-4000-8000-000000000106'; -- solo (V1 shape)
  f7 uuid := 'f1030000-0000-4000-8000-000000000107'; -- not open yet, no work order
  p1 uuid := 'f1030000-0000-4000-8000-000000000201'; -- patio with a work-order line
  p2 uuid := 'f1030000-0000-4000-8000-000000000202'; -- patio, quote labour outside its pool
  w1 uuid := 'f1030000-0000-4000-8000-000000000301';
  w2 uuid := 'f1030000-0000-4000-8000-000000000302';
  w3 uuid := 'f1030000-0000-4000-8000-000000000303';
  w4 uuid := 'f1030000-0000-4000-8000-000000000304';
  w5 uuid := 'f1030000-0000-4000-8000-000000000305';
  w6 uuid := 'f1030000-0000-4000-8000-000000000306';
  wp1 uuid := 'f1030000-0000-4000-8000-000000000311';
  wp2 uuid := 'f1030000-0000-4000-8000-000000000312';
  inv uuid;
  refused text;
  cov record;
  n int;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','ops_manager'),(alyx,org,'Alyx Synthetic','crew'),
    (henry,org,'Henry Synthetic','ops_manager'),(sonny,org,'Sonny Synthetic','crew'),
    (kim,org,'Kim Synthetic','crew'),(jan,org,'Jan Synthetic','admin')
    ON CONFLICT(id) DO NOTHING;
  -- Quoted first, so the open-status trigger opens no draft of its own.
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
    (f1,org,'fencing','quoted','SYN-V8-F1'),(f2,org,'fencing','quoted','SYN-V8-F2'),
    (f3,org,'fencing','quoted','SYN-V8-F3'),(f4,org,'fencing','quoted','SYN-V8-F4'),
    (f5,org,'fencing','quoted','SYN-V8-F5'),(f6,org,'fencing','quoted','SYN-V8-F6'),
    (f7,org,'fencing','quoted','SYN-V8-F7'),
    (p1,org,'patio','quoted','SYN-V8-P1'),(p2,org,'patio','quoted','SYN-V8-P2');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions) VALUES
    (w1,org,f1,'SYN-V8-WO1','job','draft',535,
      '[{"description":"Install Trimclad fence (5 panels)","basis":"fence_install","total":385,"counted":true,"flags":[]},
        {"description":"Install retaining plinths","basis":"fence_plinths","total":150,"counted":true,"flags":[]},
        {"description":"Remove Hardie fence","basis":"removal","total":137.5,"counted":false,"flags":["quote_counted_as_materials"]}]','Synthetic V8 proof'),
    (w2,org,f2,'SYN-V8-WO2','job','draft',0.35,
      '[{"description":"Install Ridgeside fence (1 panel)","basis":"fence_install","total":0.35,"counted":true,"flags":[]},
        {"description":"Front fence replant 3 posts","basis":"quote_labour_line","total":480,"counted":false,"flags":["saved_as_material","outside_quote_labour"]},
        {"description":"Back fence replant post","basis":"quote_labour_line","total":720,"counted":false,"flags":["saved_as_material","outside_quote_labour"]},
        {"description":"Concrete per bag","basis":"quote_extra","total":null,"counted":false,"flags":["labour_or_material_unknown"]}]','Synthetic V8 proof'),
    (w3,org,f3,'SYN-V8-WO3','job','draft',650,'[{"description":"Install Colorbond fence","basis":"fence_install","total":650,"counted":true,"flags":[]}]','Synthetic V8 proof'),
    (w4,org,f4,'SYN-V8-WO4','job','draft',770,'[{"description":"Install fence","basis":"fence_install","total":770,"counted":true,"flags":[]}]','Synthetic V8 proof'),
    (w5,org,f5,'SYN-V8-WO5','job','draft',367.5,'[{"description":"Install fence","basis":"fence_install","total":367.5,"counted":true,"flags":[]}]','Synthetic V8 proof'),
    (w6,org,f6,'SYN-V8-WO6','job','draft',787.5,'[{"description":"Install fence","basis":"fence_install","total":787.5,"counted":true,"flags":[]}]','Synthetic V8 proof'),
    (wp1,org,p1,'SYN-V8-WOP1','job','draft',2880,'[]','Synthetic V8 proof'),
    (wp2,org,p2,'SYN-V8-WOP2','job','draft',2160,
      '[{"description":"Gutter rework","basis":"quote_labour_line","total":240,"counted":false,"flags":["outside_quote_labour"]}]','Synthetic V8 proof');
  UPDATE public.work_orders SET status='approved',approved_by=office WHERE id IN (w1,w2,w3,w4,w5,w6,wp1,wp2);
  -- f7 stays quoted: an open fencing job gets a draft from the open-status
  -- trigger, so only a job that is not open yet has no work order.
  UPDATE public.jobs SET status='scheduled' WHERE id IN (f1,f2,f3,f4,f5,f6,p1,p2);
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status) VALUES
    (gen_random_uuid(),f1,alyx,'2026-11-17','scheduled'),(gen_random_uuid(),f1,henry,'2026-11-17','scheduled'),
    (gen_random_uuid(),f1,jan,'2026-11-17','scheduled'),
    (gen_random_uuid(),f2,alyx,'2026-11-18','scheduled'),(gen_random_uuid(),f2,henry,'2026-11-18','scheduled'),
    (gen_random_uuid(),f2,sonny,'2026-11-18','scheduled'),
    (gen_random_uuid(),f3,henry,'2026-11-10','scheduled'),(gen_random_uuid(),f3,sonny,'2026-11-10','scheduled'),
    (gen_random_uuid(),f3,kim,'2026-11-10','scheduled'),
    (gen_random_uuid(),f4,alyx,'2026-11-12','scheduled'),(gen_random_uuid(),f4,sonny,'2026-11-12','scheduled'),
    (gen_random_uuid(),f5,alyx,'2026-11-19','scheduled'),(gen_random_uuid(),f5,henry,'2026-11-19','scheduled'),
    (gen_random_uuid(),f6,alyx,'2026-11-12','scheduled'),(gen_random_uuid(),f6,jan,'2026-11-12','scheduled'),
    (gen_random_uuid(),f7,alyx,'2026-11-12','scheduled'),(gen_random_uuid(),f7,kim,'2026-11-12','scheduled'),
    (gen_random_uuid(),p1,alyx,'2026-11-12','scheduled'),(gen_random_uuid(),p1,sonny,'2026-11-12','scheduled'),
    (gen_random_uuid(),p2,alyx,'2026-11-13','scheduled'),(gen_random_uuid(),p2,kim,'2026-11-13','scheduled');

  -- Henry's fixed-price claim on f3, as SW-INV-A-261011-029 billed SWF-26968;
  -- the same kind of line on patio p1. Alyx's hours on f4.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,henry,'paid',610,610,0,610,false,0.12,73.20,573.40,'SYN-V8-H1') RETURNING id INTO inv;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,total_hours,line_total_ex) VALUES
    (inv,f3,'work order',E'Work order $650.00.\nLess labour: Sonny 3h x $35 = $105.00\nKim 8h x $30 = $240.00.\nTotal labour deducted $345.00.',1,305),
    (inv,p1,'work order','Work order $305.00.',1,305);
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,alyx,'pending_acknowledgment',300,300,0,300,false,0.12,36,282,'SYN-V8-A1') RETURNING id INTO inv;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,total_hours,hourly_rate,line_total_ex)
    VALUES(inv,f4,'labour','Fence install',7.5,40,300);

  -- 1. A fence lead's work-order claim blocks a group in the database, as
  --    hours do; a fence job with no pay takes one.
  refused := NULL;
  BEGIN
    INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,pay_basis)
      VALUES(org,f3,w3,'synthetic-v8-token-3','all_in_12_v2');
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_open_blocked_by_work_order_claim' THEN
    RAISE EXCEPTION 'a fence work-order claim did not block a group: %', refused;
  END IF;
  INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(org,f1,w1,'synthetic-v8-token-1','all_in_12_v2');

  -- 2. Weekly coverage, fencing.
  SELECT * INTO cov FROM public.v_group_coverage WHERE job_id=f1;
  IF NOT FOUND OR cov.job_type <> 'fencing' OR cov.crew_count <> 2 OR cov.week_start <> '2026-11-16'
     OR cov.agreed_labour_ex <> 535 OR NOT cov.covered OR cov.reason <> 'covered' THEN
    RAISE EXCEPTION 'coverage f1 wrong: %', row_to_json(cov);
  END IF;
  SELECT * INTO cov FROM public.v_group_coverage WHERE job_id=f2;
  IF NOT FOUND OR cov.covered OR NOT cov.priced_work_order OR NOT cov.labour_outside_pool
     OR cov.reason <> 'labour_outside_pool' THEN
    RAISE EXCEPTION 'fence guard lost: coverage f2 wrong: %', row_to_json(cov);
  END IF;
  SELECT * INTO cov FROM public.v_group_coverage WHERE job_id=f3;
  IF NOT FOUND OR cov.covered OR NOT cov.normal_pay_on_job OR NOT cov.work_order_claim_on_job
     OR cov.reason <> 'work_order_claimed_already' THEN
    RAISE EXCEPTION 'coverage f3 wrong: %', row_to_json(cov);
  END IF;
  SELECT * INTO cov FROM public.v_group_coverage WHERE job_id=f4;
  IF NOT FOUND OR cov.covered OR cov.work_order_claim_on_job OR cov.reason <> 'crew_paid_by_hours_already' THEN
    RAISE EXCEPTION 'coverage f4 wrong: %', row_to_json(cov);
  END IF;
  SELECT * INTO cov FROM public.v_group_coverage WHERE job_id=f5;
  IF NOT FOUND OR cov.covered OR NOT cov.job_open OR cov.auto_switch_on OR cov.reason <> 'no_group_yet' THEN
    RAISE EXCEPTION 'coverage f5 wrong: %', row_to_json(cov);
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_group_coverage WHERE job_id=f6) THEN
    RAISE EXCEPTION 'coverage counted a solo fence job (an admin is not crew)';
  END IF;
  SELECT * INTO cov FROM public.v_group_coverage WHERE job_id=f7;
  IF NOT FOUND OR cov.job_open OR cov.reason <> 'no_work_order' THEN
    RAISE EXCEPTION 'coverage f7 wrong: %', row_to_json(cov);
  END IF;

  -- 3. Patio rows read exactly as v_patio_group_coverage: a patio work-order
  --    line stays crew_paid_by_hours_already, and quoted labour outside a
  --    patio pool does not hold its group back.
  SELECT * INTO cov FROM public.v_group_coverage WHERE job_id=p1;
  IF NOT FOUND OR cov.job_type <> 'patio' OR cov.reason <> 'crew_paid_by_hours_already' THEN
    RAISE EXCEPTION 'coverage p1 wrong: %', row_to_json(cov);
  END IF;
  SELECT * INTO cov FROM public.v_group_coverage WHERE job_id=p2;
  IF NOT FOUND OR cov.reason <> 'no_group_yet' THEN
    RAISE EXCEPTION 'coverage p2 wrong: %', row_to_json(cov);
  END IF;
  SELECT count(*) INTO n FROM (
    (SELECT job_id, job_number, job_status, week_start, crew_count, work_order_id, work_order_status,
            agreed_labour_ex, priced_work_order, group_id, normal_pay_on_job, covered, reason
       FROM public.v_group_coverage WHERE job_type='patio'
     EXCEPT ALL
     SELECT job_id, job_number, job_status, week_start, crew_count, work_order_id, work_order_status,
            agreed_labour_ex, priced_work_order, group_id, normal_pay_on_job, covered, reason
       FROM public.v_patio_group_coverage)
    UNION ALL
    (SELECT job_id, job_number, job_status, week_start, crew_count, work_order_id, work_order_status,
            agreed_labour_ex, priced_work_order, group_id, normal_pay_on_job, covered, reason
       FROM public.v_patio_group_coverage
     EXCEPT ALL
     SELECT job_id, job_number, job_status, week_start, crew_count, work_order_id, work_order_status,
            agreed_labour_ex, priced_work_order, group_id, normal_pay_on_job, covered, reason
       FROM public.v_group_coverage WHERE job_type='patio')
  ) d;
  IF n <> 0 THEN
    RAISE EXCEPTION 'patio rows differ from v_patio_group_coverage: % rows', n;
  END IF;

  -- 4. The helper: a priced line flagged outside_quote_labour, nothing else.
  IF NOT public.group_work_order_labour_outside_pool('[{"total":480,"flags":["saved_as_material","outside_quote_labour"]}]')
     OR public.group_work_order_labour_outside_pool('[{"total":137.5,"flags":["quote_counted_as_materials"]}]')
     OR public.group_work_order_labour_outside_pool('[{"total":null,"flags":["outside_quote_labour"]}]')
     OR public.group_work_order_labour_outside_pool('[{"total":0,"flags":["outside_quote_labour"]}]')
     OR public.group_work_order_labour_outside_pool('[{"total":"480","flags":["outside_quote_labour"]}]')
     OR public.group_work_order_labour_outside_pool('[]')
     OR public.group_work_order_labour_outside_pool('{}')
     OR public.group_work_order_labour_outside_pool(NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'labour outside pool helper wrong';
  END IF;

  -- 5. The fence switch is added off and reads off in the view; the patio
  --    switch is untouched; the view is service role only.
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name='group_work_order_auto_fence_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'auto fence flag missing or on';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='group_work_order_auto_patio_v1') THEN
    RAISE EXCEPTION 'auto patio flag lost';
  END IF;
  UPDATE public.feature_flags SET enabled=true WHERE flag_name='group_work_order_auto_fence_v1';
  IF NOT (SELECT auto_switch_on FROM public.v_group_coverage WHERE job_id=f5)
     OR (SELECT auto_switch_on FROM public.v_group_coverage WHERE job_id=p2)
        IS DISTINCT FROM (SELECT enabled FROM public.feature_flags WHERE flag_name='group_work_order_auto_patio_v1') THEN
    RAISE EXCEPTION 'auto_switch_on does not follow each type''s own flag';
  END IF;
  IF has_table_privilege('anon','public.v_group_coverage','SELECT')
     OR has_table_privilege('authenticated','public.v_group_coverage','SELECT')
     OR NOT has_table_privilege('service_role','public.v_group_coverage','SELECT') THEN
    RAISE EXCEPTION 'coverage grants wrong';
  END IF;
END $$;
ROLLBACK;
