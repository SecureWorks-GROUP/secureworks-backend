-- ZZTEST roles and the made-up figures from spec test 15, rolled back by each contract.
CREATE FUNCTION pg_temp.zztest_group_fixture() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := 'f1171901-0000-4000-8000-000000000001';
  crew_a uuid := 'f1171901-0000-4000-8000-000000000002';
  crew_b uuid := 'f1171901-0000-4000-8000-000000000003';
  crew_c uuid := 'f1171901-0000-4000-8000-000000000004';
  job uuid := 'f1171901-0000-4000-8000-000000000101';
  wo uuid := 'f1171901-0000-4000-8000-000000000201';
  grp uuid := 'f1171901-0000-4000-8000-000000000301';
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'ZZTEST office','admin'),(crew_a,org,'ZZTEST crew A','crew'),
    (crew_b,org,'ZZTEST crew B','crew'),(crew_c,org,'ZZTEST crew C','crew');
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','quoted','ZZTEST-P4');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'ZZTEST-P4-WO','job','draft',2240,'[]','ZZTEST group contract');
  UPDATE public.work_order_settings SET approver_user_ids=ARRAY[office] WHERE id=1;
  UPDATE public.jobs SET status='accepted' WHERE id=job;
  UPDATE public.work_orders SET status='approved',approved_by=office,approved_via='session' WHERE id=wo;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(grp,org,job,wo,'ZZTEST-P4-share-token','inclusive_12_112_v1');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,crew_a),(grp,crew_b),(grp,crew_c);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,crew_a,60,'2026-01-01'),(gen_random_uuid(),org,crew_b,30,'2026-01-01'),
    (gen_random_uuid(),org,crew_c,50,'2026-01-01');
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,crew_a,'2026-11-16','07:00','17:00',0,10),(grp,crew_b,'2026-11-16','07:00','17:00',0,10),
    (grp,crew_c,'2026-11-16','00:00','22:00',0,22);
  INSERT INTO public.job_media(id,job_id,phase,type,storage_url)
    VALUES('f1171901-0000-4000-8000-000000000401',job,'signature','photo','data:image/png;base64,iVBORw0KGgo=');
  INSERT INTO public.job_client_signoffs(job_id,method,signed_name,happy,signature_media_id,captured_by_actor,created_at)
    VALUES(job,'share_link','ZZTEST customer',true,'f1171901-0000-4000-8000-000000000401','ZZTEST customer',clock_timestamp()+interval '1 second');
  RETURN grp;
END $$;
