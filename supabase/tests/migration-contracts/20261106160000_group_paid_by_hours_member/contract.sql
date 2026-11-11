-- One crew member already paid by the hour on a job: the rest of the crew
-- still get a group, the paid member is out of the crew and the split, the
-- pot is the work order less what they were paid (on the group's pay basis),
-- the freeze records that amount and the release stops if it moves. Only
-- hours billed in Xero (AUTHORISED or PAID) count as paid: a draft or a
-- voided bill is an unresolved claim that refuses the group opening and the
-- freeze until it is withdrawn or billed. A work-order claim still refuses a
-- group. Synthetic records only; rolled back.
-- The first check (step 0) is the break target.
BEGIN;

-- Fixture-only: the client sign-off is not what this proves. Restored by the
-- rollback below.
CREATE OR REPLACE FUNCTION public.group_client_signoff_counts(p_job uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := 'f1061600-0000-4000-8000-0000000000a1';
  crew_a uuid := 'f1061600-0000-4000-8000-0000000000a2';
  crew_b uuid := 'f1061600-0000-4000-8000-0000000000a3';
  paid_c uuid := 'f1061600-0000-4000-8000-0000000000a4';
  job uuid := 'f1061600-0000-4000-8000-000000000111';
  claim_job uuid := 'f1061600-0000-4000-8000-000000000112';
  small_job uuid := 'f1061600-0000-4000-8000-000000000113';
  wo uuid := 'f1061600-0000-4000-8000-000000000311';
  claim_wo uuid := 'f1061600-0000-4000-8000-000000000312';
  small_wo uuid := 'f1061600-0000-4000-8000-000000000313';
  grp uuid := 'f1061600-0000-4000-8000-000000000211';
  small_grp uuid := 'f1061600-0000-4000-8000-000000000213';
  inv_c uuid := 'f1061600-0000-4000-8000-000000000411';
  inv_claim uuid := 'f1061600-0000-4000-8000-000000000412';
  inv_small uuid := 'f1061600-0000-4000-8000-000000000413';
  crew uuid[];
  split jsonb;
  st jsonb;
  refused text;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','admin'),(crew_a,org,'Crew Synthetic A','crew'),
    (crew_b,org,'Crew Synthetic B','crew'),(paid_c,org,'Crew Synthetic C','crew')
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
    (job,org,'patio','quoted','SYN-PAID-HOURS-1'),
    (claim_job,org,'patio','quoted','SYN-PAID-HOURS-2'),
    (small_job,org,'patio','quoted','SYN-PAID-HOURS-3');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions) VALUES
    (wo,org,job,'SYN-PAID-HOURS-WO-1','job','draft',1000,'[]','Synthetic paid-by-hours proof'),
    (claim_wo,org,claim_job,'SYN-PAID-HOURS-WO-2','job','draft',1000,'[]','Synthetic paid-by-hours proof'),
    (small_wo,org,small_job,'SYN-PAID-HOURS-WO-3','job','draft',100,'[]','Synthetic paid-by-hours proof');
  UPDATE public.work_order_settings SET approver_user_ids=ARRAY[office] WHERE id=1;
  UPDATE public.jobs SET status = 'accepted' WHERE id IN (SELECT job_id FROM public.work_orders WHERE id IN (wo,claim_wo,small_wo));
  UPDATE public.work_orders SET status='approved',approved_by=office,approved_via='session'
    WHERE id IN (wo,claim_wo,small_wo);
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status) VALUES
    (gen_random_uuid(),job,crew_a,'2026-10-19','scheduled'),
    (gen_random_uuid(),job,crew_b,'2026-10-19','scheduled'),
    (gen_random_uuid(),job,paid_c,'2026-10-19','scheduled');
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,crew_a,50,'2026-01-01'),(gen_random_uuid(),org,crew_b,50,'2026-01-01'),
    (gen_random_uuid(),org,paid_c,50,'2026-01-01');

  -- Crew C has ordinary hours on the job, still a draft: not paid yet.
  INSERT INTO public.trade_invoices(id,org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(inv_c,org,paid_c,'draft',100,100,0,100,false,0.12,12,94,'SYN-PAID-HOURS-INV-1');
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,line_total_ex)
    VALUES(inv_c,job,'labour','Synthetic hours',100);

  -- 0. A claim not billed in Xero is not paid: nothing comes off the pot,
  --    C stays crew, and the group cannot open until it is withdrawn or billed.
  IF public.group_work_order_paid_by_hours(job, paid_c)
     OR public.group_work_order_hours_paid_total(job, 'all_in_12_v2') <> 0
     OR (SELECT array_agg(h.user_id) FROM public.group_work_order_hours_unresolved(job) h) IS DISTINCT FROM ARRAY[paid_c] THEN
    RAISE EXCEPTION 'paid-by-hours: an unbilled draft was read as paid';
  END IF;
  refused := NULL;
  BEGIN
    INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
      VALUES(grp,org,job,wo,'synthetic-paid-hours-token-1','all_in_12_v2');
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_open_blocked_by_hours_claim' THEN
    RAISE EXCEPTION 'paid-by-hours: an unbilled hours claim did not hold the group: %', refused;
  END IF;
  IF NOT public.group_work_order_invoice_billed('paid', 'SYN-BILL', 'PAID')
     OR NOT public.group_work_order_invoice_billed('pushed_to_xero', 'SYN-BILL', 'authorised')
     OR public.group_work_order_invoice_billed('draft', NULL, NULL)
     OR public.group_work_order_invoice_billed('pushed_to_xero', 'SYN-BILL', NULL)
     OR public.group_work_order_invoice_billed('pushed_to_xero', 'SYN-BILL', 'DRAFT')
     OR public.group_work_order_invoice_billed('pushed_to_xero', 'SYN-BILL', 'VOIDED')
     OR public.group_work_order_invoice_billed('approved', 'SYN-BILL', 'DELETED')
     OR public.group_work_order_invoice_billed('paid', ' ', 'PAID')
     OR public.group_work_order_invoice_billed('ops-reject', 'SYN-BILL', 'PAID') THEN
    RAISE EXCEPTION 'paid-by-hours: billed reading is wrong';
  END IF;

  -- C's hours are billed and paid in Xero.
  UPDATE public.trade_invoices SET status='paid', xero_bill_id='SYN-BILL-1', xero_bill_status='PAID' WHERE id = inv_c;

  -- 1. The group opens over someone else's paid ordinary hours.
  BEGIN
    INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
      VALUES(grp,org,job,wo,'synthetic-paid-hours-token-1','all_in_12_v2');
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'paid-by-hours: the rest of the crew could not open a group (%)', SQLERRM;
  END;

  -- The helpers: what counts as paid hours, and the pot a paid gross uses.
  IF NOT public.group_work_order_line_is_paid_hours('labour', NULL, 'Synthetic hours')
     OR public.group_work_order_line_is_paid_hours('work order', NULL, 'Synthetic claim')
     OR public.group_work_order_line_is_paid_hours('work_order', NULL, 'Synthetic claim')
     OR public.group_work_order_line_is_paid_hours('labour', wo, 'Synthetic crew work order line') THEN
    RAISE EXCEPTION 'paid-by-hours: line reading is wrong';
  END IF;
  IF public.group_work_order_hours_paid_budget('gross_v1', 100) <> 100
     OR public.group_work_order_hours_paid_budget('all_in_12_6_v1', 100) <> 106
     OR public.group_work_order_hours_paid_budget('all_in_12_v2', 100) <> 112
     OR public.group_work_order_hours_paid_budget('all_in_12_v2', 0) <> 0
     OR public.group_work_order_hours_paid_budget('all_in_12_v2', NULL) <> 0 THEN
    RAISE EXCEPTION 'paid-by-hours: pot used by paid hours is wrong';
  END IF;
  IF NOT public.group_work_order_paid_by_hours(job, paid_c)
     OR public.group_work_order_paid_by_hours(job, crew_a) THEN
    RAISE EXCEPTION 'paid-by-hours: who was paid by the hour is wrong';
  END IF;
  IF public.group_work_order_hours_paid_total(job, 'all_in_12_v2') <> 112 THEN
    RAISE EXCEPTION 'paid-by-hours: total paid by the hour is wrong';
  END IF;

  -- 2. The paid member is not crew, even when they joined before being paid.
  INSERT INTO public.group_work_order_participants(group_id,user_id)
    VALUES(grp,crew_a),(grp,crew_b),(grp,paid_c);
  SELECT array_agg(c.user_id ORDER BY c.user_id) INTO crew FROM public.group_work_order_crew(ARRAY[job]) c;
  IF crew IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(ARRAY[crew_a,crew_b]) u) THEN
    RAISE EXCEPTION 'paid-by-hours: crew still holds the paid member: %', crew;
  END IF;
  -- Their own hours, if logged, are ignored; they are never owed.
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,crew_a,'2026-10-19','07:00','13:00',0,6),
    (grp,crew_b,'2026-10-19','07:00','09:00',0,2),
    (grp,paid_c,'2026-10-19','07:00','15:00',0,8);

  -- 3. The pot is the work order less the paid pay with full employer super
  --    (100 gross uses 112); the rest split by hours and rate.
  split := public.group_work_order_write_split(grp, false);
  IF (split->>'hours_paid_ex')::numeric <> 112
     OR jsonb_array_length(split->'shares') <> 2
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(split->'shares') s WHERE (s->>'user_id')::uuid = paid_c)
     OR (SELECT sum((s->>'share_ex')::numeric) FROM jsonb_array_elements(split->'shares') s) <> 888
     OR (SELECT (s->>'share_ex')::numeric FROM jsonb_array_elements(split->'shares') s WHERE (s->>'user_id')::uuid = crew_a) <> 666
     OR (SELECT (s->>'share_ex')::numeric FROM jsonb_array_elements(split->'shares') s WHERE (s->>'user_id')::uuid = crew_b) <> 222 THEN
    RAISE EXCEPTION 'paid-by-hours: projected split is wrong: %', split;
  END IF;

  -- A bill voided before the freeze is an unresolved claim again: the
  -- projection still prices, but the freeze waits and writes no share.
  UPDATE public.trade_invoices SET xero_bill_status='VOIDED' WHERE id = inv_c;
  refused := NULL;
  BEGIN PERFORM public.group_work_order_write_split(grp, true);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_hours_claim_unresolved'
     OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id = grp) IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.group_work_order_shares WHERE group_id = grp) THEN
    RAISE EXCEPTION 'paid-by-hours: freeze went past an unbilled hours claim: %', refused;
  END IF;
  UPDATE public.trade_invoices SET xero_bill_status='PAID' WHERE id = inv_c;

  -- 4. The freeze records what came off the pot, and locks it.
  PERFORM public.group_work_order_write_split(grp, true);
  IF (SELECT hours_paid_ex FROM public.group_work_orders WHERE id = grp) IS DISTINCT FROM 112.00
     OR (SELECT count(*) FROM public.group_work_order_shares WHERE group_id = grp) <> 2
     OR (SELECT sum(share_ex) FROM public.group_work_order_shares WHERE group_id = grp) <> 888
     OR EXISTS (SELECT 1 FROM public.group_work_order_shares WHERE group_id = grp AND user_id = paid_c) THEN
    RAISE EXCEPTION 'paid-by-hours: frozen split is wrong';
  END IF;
  refused := NULL;
  BEGIN
    UPDATE public.group_work_orders SET hours_paid_ex = 0 WHERE id = grp;
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_split_frozen' THEN
    RAISE EXCEPTION 'paid-by-hours: recorded pay changed after the freeze: %', refused;
  END IF;

  -- The release reconciles against the pot less the recorded pay and does
  -- not wait on a share for the paid member.
  st := public.group_work_order_release_state(grp);
  IF st->'reasons' ?| ARRAY['participant_without_share','pool_not_reconciled','hours_paid_changed'] THEN
    RAISE EXCEPTION 'paid-by-hours: release blocked on the paid member: %', st->'reasons';
  END IF;

  -- If the paid pay moves after the freeze (the bill is voided), the release stops.
  UPDATE public.trade_invoices SET xero_bill_status = 'VOIDED' WHERE id = inv_c;
  st := public.group_work_order_release_state(grp);
  IF NOT (st->'reasons' ? 'hours_paid_changed') THEN
    RAISE EXCEPTION 'paid-by-hours: release missed a change in paid pay: %', st->'reasons';
  END IF;
  UPDATE public.trade_invoices SET xero_bill_status = 'PAID' WHERE id = inv_c;

  -- 5. A work-order claim still refuses a group.
  INSERT INTO public.trade_invoices(id,org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(inv_claim,org,paid_c,'draft',100,100,0,100,false,0.12,12,94,'SYN-PAID-HOURS-INV-2');
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,line_total_ex)
    VALUES(inv_claim,claim_job,'work order','Synthetic claim',100);
  refused := NULL;
  BEGIN
    INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,pay_basis)
      VALUES(org,claim_job,claim_wo,'synthetic-paid-hours-token-2','all_in_12_v2');
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_open_blocked_by_work_order_claim' THEN
    RAISE EXCEPTION 'paid-by-hours: a work-order claim did not refuse a group: %', refused;
  END IF;

  -- Paid pay that uses the whole pot leaves nothing to split.
  INSERT INTO public.trade_invoices(id,org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number,xero_bill_id,xero_bill_status)
    VALUES(inv_small,org,paid_c,'pushed_to_xero',100,100,0,100,false,0.12,12,94,'SYN-PAID-HOURS-INV-3','SYN-BILL-3','AUTHORISED');
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,line_total_ex)
    VALUES(inv_small,small_job,'labour','Synthetic hours',100);
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(small_grp,org,small_job,small_wo,'synthetic-paid-hours-token-3','gross_v1');
  refused := NULL;
  BEGIN PERFORM public.group_work_order_write_split(small_grp, false);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_pot_used_by_hours_pay' THEN
    RAISE EXCEPTION 'paid-by-hours: a pot used up by paid hours was split: %', refused;
  END IF;

  IF has_function_privilege('anon','public.group_work_order_hours_paid_total(uuid,text)','execute')
     OR has_function_privilege('authenticated','public.group_work_order_paid_by_hours(uuid,uuid)','execute')
     OR has_function_privilege('authenticated','public.group_work_order_hours_unresolved(uuid)','execute')
     OR has_function_privilege('anon','public.group_work_order_invoice_billed(text,text,text)','execute')
     OR NOT has_function_privilege('service_role','public.group_work_order_hours_unresolved(uuid)','execute')
     OR NOT has_function_privilege('service_role','public.group_work_order_hours_paid_total(uuid,text)','execute') THEN
    RAISE EXCEPTION 'paid-by-hours: function access changed';
  END IF;
END $$;
ROLLBACK;
