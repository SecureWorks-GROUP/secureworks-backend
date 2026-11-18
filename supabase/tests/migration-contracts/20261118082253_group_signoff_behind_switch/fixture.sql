-- ZZTEST roles and made-up figures only, rolled back by each contract.
-- One crew of three with hours, a priced approved job work order, and no
-- customer sign-off. Each call makes a separate job and group.
CREATE FUNCTION pg_temp.zztest_p1132_users() RETURNS void LANGUAGE plpgsql AS $$
DECLARE org uuid := '00000000-0000-0000-0000-000000000001'; /* block */ BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    ('f1132000-0000-4000-8000-000000000001',org,'ZZTEST office','admin'),
    ('f1132000-0000-4000-8000-000000000002',org,'ZZTEST crew A','crew'),
    ('f1132000-0000-4000-8000-000000000003',org,'ZZTEST crew B','crew'),
    ('f1132000-0000-4000-8000-000000000004',org,'ZZTEST crew C','crew');
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,'f1132000-0000-4000-8000-000000000002',60,'2026-01-01'),
    (gen_random_uuid(),org,'f1132000-0000-4000-8000-000000000003',30,'2026-01-01'),
    (gen_random_uuid(),org,'f1132000-0000-4000-8000-000000000004',50,'2026-01-01');
  UPDATE public.work_order_settings SET approver_user_ids=ARRAY['f1132000-0000-4000-8000-000000000001'::uuid] WHERE id=1;
END $$;

CREATE FUNCTION pg_temp.zztest_p1132_group(p_n int, OUT grp uuid, OUT job uuid) LANGUAGE plpgsql AS $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := 'f1132000-0000-4000-8000-000000000001';
  wo uuid := gen_random_uuid();
/* block */ BEGIN
  job := gen_random_uuid(); grp := gen_random_uuid();
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','quoted','ZZTEST-P1132-'||p_n);
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'ZZTEST-P1132-WO-'||p_n,'job','draft',2240,'[]','ZZTEST sign-off contract');
  UPDATE public.jobs SET status='accepted' WHERE id=job;
  UPDATE public.work_orders SET status='approved',approved_by=office,approved_via='session' WHERE id=wo;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(grp,org,job,wo,'ZZTEST-P1132-token-'||p_n,'inclusive_12_112_v1');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES
    (grp,'f1132000-0000-4000-8000-000000000002'),(grp,'f1132000-0000-4000-8000-000000000003'),
    (grp,'f1132000-0000-4000-8000-000000000004');
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,'f1132000-0000-4000-8000-000000000002','2026-11-16','07:00','17:00',0,10),
    (grp,'f1132000-0000-4000-8000-000000000003','2026-11-16','07:00','17:00',0,10),
    (grp,'f1132000-0000-4000-8000-000000000004','2026-11-16','00:00','22:00',0,22);
END $$;

-- A drawn, happy customer sign-off newer than every hour on the job.
CREATE FUNCTION pg_temp.zztest_p1132_drawn(p_job uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m uuid := gen_random_uuid(); /* block */ BEGIN
  INSERT INTO public.job_media(id,job_id,phase,type,storage_url)
    VALUES(m,p_job,'signature','photo','data:image/png;base64,iVBORw0KGgo=');
  INSERT INTO public.job_client_signoffs(job_id,method,signed_name,happy,signature_media_id,captured_by_actor,created_at)
    VALUES(p_job,'share_link','ZZTEST customer',true,m,'ZZTEST customer',clock_timestamp()+interval '1 day');
END $$;

-- A group share line of 672.00 on a new inclusive invoice for crew A.
CREATE FUNCTION pg_temp.zztest_p1132_share_line(p_job uuid, p_n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE inv uuid; /* block */ BEGIN
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES('00000000-0000-0000-0000-000000000001','f1132000-0000-4000-8000-000000000002','pending_acknowledgment',
      672,672,0,672,false,.12,72,600,'inclusive_12_112_v1','ZZTEST-P1132-I-'||p_n) RETURNING id INTO inv;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
    VALUES(inv,p_job,'group share',672);
  RETURN inv;
END $$;

CREATE FUNCTION pg_temp.zztest_p1132_switch(p_on boolean) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.feature_flags(flag_name, enabled) VALUES ('trade_invoice_requires_client_signoff_v1', p_on)
    ON CONFLICT (flag_name) DO UPDATE SET enabled = p_on;
$$;
