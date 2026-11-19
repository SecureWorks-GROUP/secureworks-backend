-- An inclusive group (inclusive_12_112_v1) takes hourly pay billed on an
-- old-rule invoice off its pot at the gross plus the company's own super on
-- it; hourly pay billed on the one super rule at its gross, as before; every
-- older group basis exactly as main; hourly pay with no super record refuses
-- rather than reading as 0. Synthetic records only (ZZTEST amounts); rolled
-- back. Case 0 (the no-split refusal) is the break target.
BEGIN;
SET LOCAL statement_timeout = '60s';

-- Fixture-only: the client sign-off is not what this proves. Rolled back.
CREATE OR REPLACE FUNCTION public.group_client_signoff_counts(p_job uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := 'f1119095-0000-4000-8000-0000000000a1';
  crew_a uuid := 'f1119095-0000-4000-8000-0000000000a2';
  crew_b uuid := 'f1119095-0000-4000-8000-0000000000a3';
  paid_old uuid := 'f1119095-0000-4000-8000-0000000000a4';
  paid_new uuid := 'f1119095-0000-4000-8000-0000000000a5';
  paid_mix uuid := 'f1119095-0000-4000-8000-0000000000a6';
  job_old uuid := 'f1119095-0000-4000-8000-000000000111';
  job_new uuid := 'f1119095-0000-4000-8000-000000000112';
  job_kept uuid := 'f1119095-0000-4000-8000-000000000113';
  job_mix uuid := 'f1119095-0000-4000-8000-000000000114';
  job_none uuid := 'f1119095-0000-4000-8000-000000000115';
  job_bare uuid := 'f1119095-0000-4000-8000-000000000116';
  wo_old uuid := 'f1119095-0000-4000-8000-000000000311';
  wo_new uuid := 'f1119095-0000-4000-8000-000000000312';
  wo_kept uuid := 'f1119095-0000-4000-8000-000000000313';
  grp_old uuid := 'f1119095-0000-4000-8000-000000000211';
  grp_new uuid := 'f1119095-0000-4000-8000-000000000212';
  grp_kept uuid := 'f1119095-0000-4000-8000-000000000213';
  inv_old uuid := 'f1119095-0000-4000-8000-000000000411';
  inv_new uuid := 'f1119095-0000-4000-8000-000000000412';
  inv_kept uuid := 'f1119095-0000-4000-8000-000000000413';
  inv_mix_old uuid := 'f1119095-0000-4000-8000-000000000414';
  inv_mix_new uuid := 'f1119095-0000-4000-8000-000000000415';
  inv_carve uuid := 'f1119095-0000-4000-8000-000000000416';
  inv_bare uuid := 'f1119095-0000-4000-8000-000000000417';
  inv_comm uuid := 'f1119095-0000-4000-8000-000000000418';
  split jsonb;
  st jsonb;
  b text;
  refused text;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'ZZTEST Office','admin'),(crew_a,org,'ZZTEST Crew A','crew'),
    (crew_b,org,'ZZTEST Crew B','crew'),(paid_old,org,'ZZTEST Hourly Old','crew'),
    (paid_new,org,'ZZTEST Hourly New','crew'),(paid_mix,org,'ZZTEST Hourly Mixed','crew')
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
    (job_old,org,'patio','quoted','ZZTEST-OLD-RULE-1'),
    (job_new,org,'patio','quoted','ZZTEST-OLD-RULE-2'),
    (job_kept,org,'patio','quoted','ZZTEST-OLD-RULE-3'),
    (job_mix,org,'patio','quoted','ZZTEST-OLD-RULE-4'),
    (job_none,org,'patio','quoted','ZZTEST-OLD-RULE-5'),
    (job_bare,org,'patio','quoted','ZZTEST-OLD-RULE-6');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions) VALUES
    (wo_old,org,job_old,'ZZTEST-OLD-RULE-WO-1','job','draft',1000,'[]','ZZTEST old-rule hourly proof'),
    (wo_new,org,job_new,'ZZTEST-OLD-RULE-WO-2','job','draft',1000,'[]','ZZTEST old-rule hourly proof'),
    (wo_kept,org,job_kept,'ZZTEST-OLD-RULE-WO-3','job','draft',1000,'[]','ZZTEST old-rule hourly proof');
  UPDATE public.work_order_settings SET approver_user_ids=ARRAY[office] WHERE id=1;
  UPDATE public.jobs SET status = 'accepted' WHERE id IN (job_old, job_new, job_kept);
  UPDATE public.work_orders SET status='approved',approved_by=office,approved_via='session'
    WHERE id IN (wo_old, wo_new, wo_kept);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,crew_a,50,'2026-01-01'),(gen_random_uuid(),org,crew_b,50,'2026-01-01');

  -- Billed hourly pay, one invoice shape each (gross 100 unless stated):
  --   inv_old / inv_kept / inv_mix_old: old rule, 12% fund less 6% withheld
  --   inv_new / inv_mix_new: the one super rule (gross 50 on inv_mix_new)
  --   inv_carve: old full 12% carve-out;  inv_bare: no split stored (own job)
  --   inv_comm: old rule with 50 of commission outside the super base
  INSERT INTO public.trade_invoices(id,org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,super_base_ex,invoice_number) VALUES
    (inv_old,org,paid_old,'draft',100,100,0,100,false,0.12,12,94,NULL,NULL,'ZZTEST-OLD-RULE-INV-1'),
    (inv_new,org,paid_new,'draft',100,100,0,100,false,0.12,10.71,89.29,'inclusive_12_112_v1',NULL,'ZZTEST-OLD-RULE-INV-2'),
    (inv_kept,org,paid_old,'draft',100,100,0,100,false,0.12,12,94,NULL,NULL,'ZZTEST-OLD-RULE-INV-3'),
    (inv_mix_old,org,paid_mix,'draft',100,100,0,100,false,0.12,12,94,NULL,NULL,'ZZTEST-OLD-RULE-INV-4'),
    (inv_mix_new,org,paid_mix,'draft',50,50,0,50,false,0.12,5.36,44.64,'inclusive_12_112_v1',NULL,'ZZTEST-OLD-RULE-INV-5'),
    (inv_carve,org,paid_old,'draft',100,100,0,100,false,0.12,12,88,NULL,NULL,'ZZTEST-OLD-RULE-INV-6'),
    (inv_comm,org,paid_new,'draft',150,150,0,150,false,0.12,12,144,NULL,100,'ZZTEST-OLD-RULE-INV-8');
  INSERT INTO public.trade_invoices(id,org_id,user_id,status,subtotal_ex,total_inc,invoice_number) VALUES
    (inv_bare,org,paid_mix,'draft',100,100,'ZZTEST-OLD-RULE-INV-7');
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,description,line_total_ex) VALUES
    (inv_old,job_old,'labour','ZZTEST hours',100),
    (inv_new,job_new,'labour','ZZTEST hours',100),
    (inv_kept,job_kept,'labour','ZZTEST hours',100),
    (inv_mix_old,job_mix,'labour','ZZTEST hours',100),
    (inv_mix_new,job_mix,'labour','ZZTEST hours',50),
    (inv_carve,job_none,'labour','ZZTEST hours',100),
    (inv_bare,job_bare,'labour','ZZTEST hours',100),
    (inv_comm,job_none,'labour','ZZTEST hours',100),
    (inv_comm,job_none,'commission','ZZTEST commission',50);
  UPDATE public.trade_invoices SET status='paid', xero_bill_id='ZZTEST-BILL-'||invoice_number, xero_bill_status='PAID'
    WHERE id IN (inv_old,inv_new,inv_kept,inv_mix_old,inv_mix_new,inv_carve,inv_bare,inv_comm);

  -- 0. Hourly pay with no super record (no split stored): an inclusive group
  --    refuses, by name, rather than pay on a guess. Removing the refusal
  --    would pass a pot of 1000 less 100 (break-contract).
  refused := NULL;
  BEGIN
    PERFORM public.group_work_order_hours_paid_total(job_bare, 'inclusive_12_112_v1');
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS NULL OR position('group_hours_paid_super_unknown' IN refused) = 0 THEN
    RAISE EXCEPTION 'no-split hourly: an inclusive group passed a wrong pot instead of refusing (%)',
      coalesce(refused, 'no refusal');
  END IF;
  refused := NULL;
  BEGIN
    PERFORM public.group_work_order_hours_paid_company_super(job_bare);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS NULL OR position('group_hours_paid_super_unknown' IN refused) = 0 THEN
    RAISE EXCEPTION 'no-split hourly: the helper must refuse (%)', coalesce(refused, 'no refusal');
  END IF;
  -- Older bases never read the record: unchanged on that job.
  IF public.group_work_order_hours_paid_total(job_bare, 'all_in_12_v2') IS DISTINCT FROM 112
     OR public.group_work_order_hours_paid_total(job_bare, 'gross_v1') IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'no-split hourly: an older basis moved';
  END IF;

  -- 1. Old-rule hourly, then an inclusive group: the gross plus the
  --    company's 6% (12% fund less 6% withheld) comes off the pot.
  IF public.group_work_order_hours_paid_total(job_old, 'inclusive_12_112_v1') IS DISTINCT FROM 106 THEN
    RAISE EXCEPTION 'old-rule hourly: an inclusive group must deduct the gross plus its company super (%)',
      public.group_work_order_hours_paid_total(job_old, 'inclusive_12_112_v1');
  END IF;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(grp_old,org,job_old,wo_old,'zztest-old-rule-token-1','inclusive_12_112_v1');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp_old,crew_a),(grp_old,crew_b);
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp_old,crew_a,'2026-11-23','07:00','13:00',0,6),(grp_old,crew_b,'2026-11-23','07:00','09:00',0,2);
  split := public.group_work_order_write_split(grp_old, false);
  IF (split->>'hours_paid_ex')::numeric IS DISTINCT FROM 106
     OR (SELECT sum((s->>'share_ex')::numeric) FROM jsonb_array_elements(split->'shares') s) IS DISTINCT FROM 894 THEN
    RAISE EXCEPTION 'old-rule hourly: inclusive split must share 1000 less 106: %', split;
  END IF;
  PERFORM public.group_work_order_write_split(grp_old, true);
  IF (SELECT hours_paid_ex FROM public.group_work_orders WHERE id = grp_old) IS DISTINCT FROM 106.00
     OR (SELECT sum(share_ex) FROM public.group_work_order_shares WHERE group_id = grp_old) IS DISTINCT FROM 894 THEN
    RAISE EXCEPTION 'old-rule hourly: frozen inclusive split is wrong';
  END IF;
  st := public.group_work_order_release_state(grp_old);
  IF st->'reasons' ?| ARRAY['pool_not_reconciled','hours_paid_changed'] THEN
    RAISE EXCEPTION 'old-rule hourly: release does not reconcile: %', st->'reasons';
  END IF;

  -- 2. Hourly on the one super rule, then an inclusive group: the gross only.
  IF public.group_work_order_hours_paid_total(job_new, 'inclusive_12_112_v1') IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'inclusive hourly: an inclusive group must deduct the gross only';
  END IF;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(grp_new,org,job_new,wo_new,'zztest-old-rule-token-2','inclusive_12_112_v1');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp_new,crew_a),(grp_new,crew_b);
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp_new,crew_a,'2026-11-23','07:00','13:00',0,6),(grp_new,crew_b,'2026-11-23','07:00','09:00',0,2);
  split := public.group_work_order_write_split(grp_new, false);
  IF (split->>'hours_paid_ex')::numeric IS DISTINCT FROM 100
     OR (SELECT sum((s->>'share_ex')::numeric) FROM jsonb_array_elements(split->'shares') s) IS DISTINCT FROM 900 THEN
    RAISE EXCEPTION 'inclusive hourly: inclusive split must share 1000 less 100: %', split;
  END IF;

  -- 3. An old-basis group is untouched: main's figures on every older basis,
  --    through the split as well as the helper.
  IF public.group_work_order_hours_paid_total(job_kept, 'all_in_12_v2') IS DISTINCT FROM 112
     OR public.group_work_order_hours_paid_total(job_kept, 'all_in_12_6_v1') IS DISTINCT FROM 106
     OR public.group_work_order_hours_paid_total(job_kept, 'gross_v1') IS DISTINCT FROM 100
     OR public.group_work_order_hours_paid_total(job_new, 'all_in_12_v2') IS DISTINCT FROM 112
     OR public.group_work_order_hours_paid_total(job_none, 'all_in_12_v2') IS DISTINCT FROM 224 THEN
    RAISE EXCEPTION 'old-basis group: the hourly deduction moved';
  END IF;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(grp_kept,org,job_kept,wo_kept,'zztest-old-rule-token-3','all_in_12_v2');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp_kept,crew_a),(grp_kept,crew_b);
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp_kept,crew_a,'2026-11-16','07:00','13:00',0,6),(grp_kept,crew_b,'2026-11-16','07:00','09:00',0,2);
  split := public.group_work_order_write_split(grp_kept, false);
  IF (split->>'hours_paid_ex')::numeric IS DISTINCT FROM 112
     OR (SELECT sum((s->>'share_ex')::numeric) FROM jsonb_array_elements(split->'shares') s) IS DISTINCT FROM 888 THEN
    RAISE EXCEPTION 'old-basis group: split moved: %', split;
  END IF;
  -- On every older basis the total is main's expression, value for value.
  FOREACH b IN ARRAY ARRAY['gross_v1','all_in_12_6_v1','all_in_12_v2'] LOOP
    IF public.group_work_order_hours_paid_total(job_mix, b) IS DISTINCT FROM
       (SELECT COALESCE(sum(public.group_work_order_hours_paid_budget(b, h.gross_ex)), 0)
        FROM public.group_work_order_hours_paid(job_mix) h)
       OR public.group_work_order_hours_paid_total(job_none, b) IS DISTINCT FROM
       (SELECT COALESCE(sum(public.group_work_order_hours_paid_budget(b, h.gross_ex)), 0)
        FROM public.group_work_order_hours_paid(job_none) h)
       OR public.group_work_order_hours_paid_total(job_bare, b) IS DISTINCT FROM
       (SELECT COALESCE(sum(public.group_work_order_hours_paid_budget(b, h.gross_ex)), 0)
        FROM public.group_work_order_hours_paid(job_bare) h) THEN
      RAISE EXCEPTION 'old-basis group: % no longer matches main', b;
    END IF;
  END LOOP;

  -- One payee paid on both rules: 100 old (plus 6) and 50 inclusive.
  IF public.group_work_order_hours_paid_total(job_mix, 'inclusive_12_112_v1') IS DISTINCT FROM 156 THEN
    RAISE EXCEPTION 'mixed hourly: an inclusive group must deduct 150 plus 6';
  END IF;
  -- Carve-out (0), commission outside the base (6 on the 100 of hours only):
  -- 200 gross plus 6.
  IF public.group_work_order_hours_paid_company_super(job_none) IS DISTINCT FROM 6
     OR public.group_work_order_hours_paid_total(job_none, 'inclusive_12_112_v1') IS DISTINCT FROM 206 THEN
    RAISE EXCEPTION 'old-rule shapes: company super read wrong (%)',
      public.group_work_order_hours_paid_company_super(job_none);
  END IF;
  -- A job with no hourly pay reads 0.
  IF public.group_work_order_hours_paid_total('f1119095-0000-4000-8000-000000000199', 'inclusive_12_112_v1') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'no hourly pay: an inclusive group must read 0';
  END IF;

  IF has_function_privilege('anon','public.group_work_order_hours_paid_company_super(uuid)','execute')
     OR has_function_privilege('authenticated','public.group_work_order_hours_paid_company_super(uuid)','execute')
     OR NOT has_function_privilege('service_role','public.group_work_order_hours_paid_company_super(uuid)','execute')
     OR has_function_privilege('anon','public.group_work_order_hours_paid_total(uuid,text)','execute')
     OR has_function_privilege('authenticated','public.group_work_order_hours_paid_total(uuid,text)','execute')
     OR NOT has_function_privilege('service_role','public.group_work_order_hours_paid_total(uuid,text)','execute') THEN
    RAISE EXCEPTION 'old-rule hourly: function access changed';
  END IF;
END $$;

SELECT 'PASS P1-13.4b: inclusive groups deduct old-rule hourly pay with its company super; older bases unchanged';
ROLLBACK;
