-- Real v3 -> v2 -> v1 persistence and the interacting group/job-WO triggers.
-- Synthetic records only. Every fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  crew uuid := 'f0290000-0000-4000-8000-00000000000a';
  job uuid := 'f0290000-0000-4000-8000-000000000101';
  wo uuid := 'f0290000-0000-4000-8000-000000000301';
  grp uuid := 'f0290000-0000-4000-8000-000000000201';
  media uuid := 'f0290000-0000-4000-8000-000000000501';
  invoice uuid;
  stored public.trade_invoice_lines%ROWTYPE;
BEGIN
  UPDATE public.feature_flags SET enabled=false
    WHERE flag_name='crew_invoice_line_office_review_v1';
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','ops_manager'),
    (crew,org,'Synthetic Crew','crew') ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number)
    VALUES(job,org,'fencing','quoted','SYN-GROUP-REVIEW-RPC');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'SYN-GROUP-REVIEW-WO','job','draft',2160,'[]','Synthetic RPC proof');
  UPDATE public.work_orders SET status='approved',approved_by=office WHERE id=wo;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token)
    VALUES(grp,org,job,wo,'synthetic-group-review-rpc-token');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,crew);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from)
    VALUES(gen_random_uuid(),org,crew,50,'2026-01-01');
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status)
    VALUES(gen_random_uuid(),job,crew,'2026-10-20','scheduled');
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
    VALUES(grp,crew,'2026-10-20','08:00','17:00',0,9);
  INSERT INTO public.job_media(id,job_id,phase,type,storage_url)
    VALUES(media,job,'signature','photo','data:image/png;base64,iVBORw0KGgo=');
  INSERT INTO public.job_client_signoffs(job_id,method,signed_name,happy,satisfaction_rating,signature_media_id,captured_by_actor)
    VALUES(job,'share_link','Synthetic Customer',true,5,media,'client link');
  PERFORM public.freeze_group_work_order_split(grp);

  invoice := public.persist_weekly_trade_invoice_v3(
    jsonb_build_object('org_id',org,'user_id',crew,'week_start','2026-10-19','week_end','2026-10-25',
      'status','draft','invoice_source','hourly','subtotal_ex',2160,'gross_earned',2160,
      'gst',0,'total_inc',2160,'gst_on',false,'super_rate',0.12,'super_amount',259.2,'net_pay',2030.4),
    jsonb_build_array(jsonb_build_object('job_id',job,'line_type','group share',
      'line_total_ex',2160,'quantity',1,'unit','share','unit_rate',2160,
      -- A caller cannot approve their own insertion, even though v1 omits
      -- this JSON field from its fixed INSERT projection.
      'office_review_status','approved')), NULL);
  SELECT * INTO STRICT stored FROM public.trade_invoice_lines WHERE trade_invoice_id=invoice;
  IF stored.office_review_status IS DISTINCT FROM 'awaiting'
     OR stored.group_share_id IS NULL OR stored.line_total_ex IS DISTINCT FROM 2160::numeric THEN
    RAISE EXCEPTION 'group review RPC did not preserve mandatory awaiting hold';
  END IF;
  UPDATE public.trade_invoice_lines SET office_review_status='queried' WHERE id=stored.id;
  IF (SELECT office_review_status FROM public.trade_invoice_lines WHERE id=stored.id) IS DISTINCT FROM 'queried' THEN
    RAISE EXCEPTION 'group review query did not survive storage';
  END IF;
  UPDATE public.trade_invoice_lines SET office_review_status='approved' WHERE id=stored.id;
  IF (SELECT office_review_status FROM public.trade_invoice_lines WHERE id=stored.id) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'group review insert trigger reset later office approval';
  END IF;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
    VALUES(invoice,job,'commission',1);
  IF (SELECT office_review_status FROM public.trade_invoice_lines
      WHERE trade_invoice_id=invoice AND line_type='commission') IS NOT NULL THEN
    RAISE EXCEPTION 'group-only insert rule changed ordinary commission policy';
  END IF;
END $$;
SELECT 'PASS: actual weekly RPC hold, persisted query, later approval, ordinary policy' AS result;
ROLLBACK;
