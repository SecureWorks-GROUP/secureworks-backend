-- No super on commission (Marnin, 12 Nov 2026). A trade invoice with a
-- commission line stores its super base (gross less commission); super is 12%
-- of that base and the worker withhold 6% of it. An invoice priced on the old
-- rule (super on the whole gross, super_base_ex null) stays valid. The group
-- unfreeze recalculates with the same base. Synthetic records only; every
-- fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  henry uuid := 'f1120000-0000-4000-8000-00000000000a';
  isaac uuid := 'f1120000-0000-4000-8000-00000000000b';
  ryan uuid := 'f1120000-0000-4000-8000-00000000000c';
  job uuid := 'f1120000-0000-4000-8000-000000000101';
  job2 uuid := 'f1120000-0000-4000-8000-000000000102';
  wo uuid := 'f1120000-0000-4000-8000-000000000301';
  grp uuid := 'f1120000-0000-4000-8000-000000000201';
  inv uuid; inv_h uuid; inv_i uuid;
  got record;
  refused boolean;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','ops_manager'),(henry,org,'Henry Synthetic','crew'),
    (isaac,org,'Isaac Synthetic','crew'),(ryan,org,'Ryan Synthetic','crew') ON CONFLICT(id) DO NOTHING;

  -- 1. The worked example: $1,000 of hours and $200 commission. Gross 1,200,
  --    super base 1,000, super 120, worker withhold 60, net pay 1,140.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_base_ex,invoice_number)
    VALUES(org,henry,'pending_acknowledgment',1200,1200,0,1200,false,0.12,120,1140,1000,'SYN-COMM-1') RETURNING id INTO inv;
  SELECT super_amount, net_pay, super_base_ex INTO got FROM public.trade_invoices WHERE id = inv;
  IF got.super_amount <> 120 OR got.net_pay <> 1140 OR got.super_base_ex <> 1000 THEN
    RAISE EXCEPTION 'the commission-excluded split did not store: %', got;
  END IF;
  -- With GST on: GST stays 10% of the whole gross.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_base_ex,invoice_number)
    VALUES(org,henry,'pending_acknowledgment',1200,1200,120,1320,true,0.12,120,1140,1000,'SYN-COMM-2');

  -- 2. An invoice priced before this migration (commission inside the super
  --    base, super_base_ex null) is still valid, on both old splits.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,henry,'pending_acknowledgment',1200,1200,0,1200,false,0.12,144,1128,'SYN-COMM-OLD-1');
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,henry,'pending_acknowledgment',1200,1200,0,1200,false,0.12,144,1056,'SYN-COMM-OLD-2');

  -- 3. Refused: super on the whole gross while a base is stored; a net pay
  --    off the base; the old full carve-out with a base; a base that is not
  --    below gross; a negative base; a base with no money split.
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_base_ex,invoice_number)
      VALUES(org,henry,'pending_acknowledgment',1200,1200,0,1200,false,0.12,144,1128,1000,'SYN-COMM-BAD-1');
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'super on commission stored with a super base'; END IF;
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_base_ex,invoice_number)
      VALUES(org,henry,'pending_acknowledgment',1200,1200,0,1200,false,0.12,120,1128,1000,'SYN-COMM-BAD-2');
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'a withhold on commission stored with a super base'; END IF;
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_base_ex,invoice_number)
      VALUES(org,henry,'pending_acknowledgment',1200,1200,0,1200,false,0.12,120,1080,1000,'SYN-COMM-BAD-3');
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'the old full carve-out stored with a super base'; END IF;
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_base_ex,invoice_number)
      VALUES(org,henry,'pending_acknowledgment',1200,1200,0,1200,false,0.12,144,1128,1200,'SYN-COMM-BAD-4');
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'a super base equal to gross was stored'; END IF;
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_base_ex,invoice_number)
      VALUES(org,henry,'pending_acknowledgment',1200,1200,0,1200,false,0.12,0,1200,-1,'SYN-COMM-BAD-5');
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'a negative super base was stored'; END IF;
  refused := false;
  BEGIN
    UPDATE public.trade_invoices SET gst_on = NULL, super_rate = NULL, super_amount = NULL, gross_earned = NULL, net_pay = NULL
      WHERE id = inv;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'a super base was kept without a money split'; END IF;

  -- 4. The group unfreeze strips a share line and recalculates on the same
  --    base. Henry's invoice carries a base, Isaac's was priced on the old
  --    rule. Each also bills commission on another job.
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','quoted','SYN-COMM-GROUP');
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job2,org,'fencing','accepted','SYN-COMM-OWN');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'SYN-COMM-WO','job','draft',2160,'[]','Synthetic commission proof');
  UPDATE public.jobs SET status = 'accepted' WHERE id = job;
  UPDATE public.work_orders SET status='approved',approved_by=office WHERE id=wo;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis,approved_budget_ex,budget_approved_by,budget_approved_at,budget_approval_reason)
    VALUES(grp,org,job,wo,'synthetic-commission-unfreeze-token','all_in_12_6_v1',2720,office,now(),'Synthetic owner budget');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,henry),(grp,isaac),(grp,ryan);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,henry,50,'2026-01-01'),(gen_random_uuid(),org,isaac,55,'2026-01-01'),(gen_random_uuid(),org,ryan,43,'2026-01-01');
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status) VALUES
    (gen_random_uuid(),job,henry,'2026-10-19','scheduled'),(gen_random_uuid(),job,isaac,'2026-10-19','scheduled'),(gen_random_uuid(),job,ryan,'2026-10-19','scheduled');
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,henry,'2026-10-19','07:00','16:30',30,18),(grp,isaac,'2026-10-19','07:00','16:30',30,18),(grp,ryan,'2026-10-19','07:00','16:45',30,18.5);
  INSERT INTO public.job_media(id,job_id,phase,type,storage_url)
    VALUES('f1120000-0000-4000-8000-000000000599',job,'signature','photo','data:image/png;base64,iVBORw0KGgo=');
  INSERT INTO public.job_client_signoffs(job_id,method,signed_name,happy,signature_media_id,captured_by_actor,created_at)
    VALUES(job,'share_link','Synthetic Client',true,'f1120000-0000-4000-8000-000000000599','client link',clock_timestamp() + interval '1 second');
  PERFORM public.freeze_group_work_order_split(grp);

  -- Henry: share 859.96 + commission 200. Base 859.96: super 103.20,
  -- withhold 51.60, net 1008.36.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_base_ex,invoice_number)
    VALUES(org,henry,'draft',1059.96,1059.96,0,1059.96,false,0.12,103.20,1008.36,859.96,'SYN-COMM-H') RETURNING id INTO inv_h;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES
    (inv_h,job,'group share',859.96),(inv_h,job2,'commission',200);
  -- Isaac: share 945.96 + commission 100 on the old rule (super on 1,045.96).
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,isaac,'draft',1045.96,1045.96,0,1045.96,false,0.12,125.52,983.20,'SYN-COMM-I') RETURNING id INTO inv_i;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES
    (inv_i,job,'group share',945.96),(inv_i,job2,'commission',100);

  PERFORM public.unfreeze_group_work_order_split(grp, office);

  -- Henry keeps only commission: base 0, no super, paid the whole 200.
  SELECT gross_earned, super_amount, net_pay, super_base_ex INTO got FROM public.trade_invoices WHERE id = inv_h;
  IF got.gross_earned <> 200 OR got.super_amount <> 0 OR got.net_pay <> 200 OR got.super_base_ex <> 0 THEN
    RAISE EXCEPTION 'unfreeze charged super on commission: %', got;
  END IF;
  -- Isaac stays on the old rule: super 12, net 94, no base.
  SELECT gross_earned, super_amount, net_pay, super_base_ex INTO got FROM public.trade_invoices WHERE id = inv_i;
  IF got.gross_earned <> 100 OR got.super_amount <> 12 OR got.net_pay <> 94 OR got.super_base_ex IS NOT NULL THEN
    RAISE EXCEPTION 'unfreeze re-priced an old-rule invoice: %', got;
  END IF;
END $$;
ROLLBACK;

-- 5. The migration is safe to apply twice: the unfreeze body is patched once.
DO $$
DECLARE v_def text := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
BEGIN
  IF (length(v_def) - length(replace(v_def, 'super_base_ex = m.super_base_ex', ''))) / length('super_base_ex = m.super_base_ex') <> 1 THEN
    RAISE EXCEPTION 'unfreeze body does not carry the super base exactly once';
  END IF;
END $$;
