BEGIN;
SET LOCAL statement_timeout='120s';
\ir ../../../rollbacks/20261119091000_decide_held_trade_line_down.sql
\ir ../../../migrations/20261119091000_decide_held_trade_line.sql
CREATE FUNCTION pg_temp.check_true(answer boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF answer IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %',label; END IF;
END $$;
CREATE FUNCTION pg_temp.decide(line uuid, decision text DEFAULT 'approve', changes jsonb DEFAULT '{}',
  reason text DEFAULT 'office reviewed', actor uuid DEFAULT '05100000-0000-4000-8000-000000000002')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.decide_held_trade_line(line,decision,actor,'00000000-0000-0000-0000-000000000001',changes,reason)
$$;
CREATE FUNCTION pg_temp.refused(line uuid, expected text, changes jsonb DEFAULT '{}', reason text DEFAULT 'office reviewed',
  actor uuid DEFAULT '05100000-0000-4000-8000-000000000002') RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  BEGIN PERFORM pg_temp.decide(line,'approve',changes,reason,actor);
  EXCEPTION WHEN OTHERS THEN IF SQLERRM=expected THEN RETURN; END IF; RAISE; END;
  RAISE EXCEPTION 'ZZTEST expected %',expected;
END $$;
SELECT pg_temp.check_true(has_function_privilege('service_role',fn,'execute') AND
  NOT has_function_privilege('authenticated',fn,'execute') AND NOT has_function_privilege('anon',fn,'execute'),'RPC grants')
  FROM (VALUES ('public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)')) f(fn);

-- Load synthetic historical rows without invoking unrelated release or intake writers.
-- Restore origin mode before the first decision; the existing commission triggers stay active.
SET LOCAL session_replication_role=replica;
DO $$ DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  staff uuid := '05100000-0000-4000-8000-000000000002';
  crew uuid := gen_random_uuid(); job uuid := gen_random_uuid(); wo uuid := gen_random_uuid();
  send uuid := gen_random_uuid(); holding uuid; standard uuid; follow_id uuid;
  first_line uuid; second_line uuid; third_line uuid; commission_line uuid; rejected uuid; typed uuid;
  self_booking uuid; kind uuid; original_standard jsonb; zz_run_id uuid; result jsonb;
  explicit_line uuid; receipt_line uuid; receipt uuid; bare_job uuid := gen_random_uuid(); prior_line jsonb; prior_gst numeric; unrelated uuid; report jsonb; checked jsonb;
BEGIN
  INSERT INTO public.users(id,org_id,name,role,trade_details) VALUES
    (staff,org,'ZZTEST office','owner','{}'),(crew,org,'ZZTEST trade','installer','{"gstRegistered":true}');
  INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES(job,org,'ZZTEST-0510','fencing','accepted');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,approved_at,approved_by,sealed_content_hash)
    VALUES(wo,org,job,'ZZTEST-0510-WO','job','approved',200,now(),staff,'ZZTEST sealed');
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status,is_lead,added_by,self_added_status)
    VALUES(gen_random_uuid(),job,crew,'2026-11-24','scheduled',false,'self','not_accepted') RETURNING id INTO self_booking;
  INSERT INTO public.not_job_work_types(org_id,label,division,created_by) VALUES(org,'ZZTEST other','office',staff) RETURNING id INTO kind;
  INSERT INTO public.trade_invoices(org_id,user_id,week_start,week_end,invoice_number,status,send_id,invoice_kind,
      subtotal_ex,gross_earned,super_amount,net_pay,super_rate,gst_on,gst,total_inc,total_hours,super_basis,invoice_source)
    VALUES(org,crew,'2026-11-23','2026-11-29','ZZTEST-0510','pending_ops_review',send,'standard',
      0,0,0,0,.12,true,0,0,0,'inclusive_12_112_v1','hourly') RETURNING id,to_jsonb(trade_invoices) INTO standard,original_standard;
  INSERT INTO public.trade_invoices(org_id,user_id,week_start,week_end,invoice_number,status,send_id,invoice_kind,follows_invoice_id,
      subtotal_ex,gross_earned,super_amount,net_pay,super_rate,gst_on,gst,total_inc,total_hours,super_basis,invoice_source)
    VALUES(org,crew,'2026-11-23','2026-11-29','ZZTEST-0510-H','pending_ops_review',send,'held',standard,
      0,0,0,0,.12,true,0,0,0,'inclusive_12_112_v1','hourly') RETURNING id INTO holding;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,sent_amount_ex,office_review_status,hold_reason)
    VALUES(holding,job,'other',200,200,'awaiting','not_on_crew') RETURNING id INTO first_line;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,sent_amount_ex,total_hours,hourly_rate,
    office_review_status,hold_reason) VALUES(holding,job,'labour',504,504,9,56,'awaiting','over_amount') RETURNING id INTO second_line;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,sent_amount_ex,office_review_status,hold_reason)
    VALUES(holding,job,'other',300,300,'awaiting','over_amount') RETURNING id INTO third_line;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,sent_amount_ex,office_review_status,hold_reason)
    VALUES(holding,job,'commission',0,0,'awaiting','commission_no_figure') RETURNING id INTO commission_line;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex,sent_amount_ex,office_review_status,hold_reason)
    VALUES(holding,'other',7,7,'awaiting','no_job') RETURNING id INTO typed;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,sent_amount_ex,office_review_status,hold_reason)
    VALUES(holding,job,'other',10,10,'awaiting','over_amount') RETURNING id INTO rejected;
  PERFORM set_config('session_replication_role','origin',true);
  PERFORM pg_temp.refused(first_line,'held_line_switch_off');
  UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_line_hold_v1';
  -- Follow-up 49 item 7: the cap guard is installed before the switch goes on, so every
  -- approval below (exact fit, one cent over, a raise) also passes the real guard.
  PERFORM public.install_trade_line_job_amount_guard();
  PERFORM pg_temp.check_true((SELECT count(*)=1 FROM pg_trigger WHERE tgrelid='public.trade_invoice_lines'::regclass
    AND tgname='trade_invoice_lines_job_amount_guard' AND NOT tgisinternal),'cap guard installed');
  PERFORM pg_temp.refused(first_line,'held_line_staff_required','{}','office reviewed',crew);
  UPDATE public.users SET role='admin' WHERE id=crew;
  PERFORM pg_temp.refused(first_line,'held_line_own_claim','{}','office reviewed',crew);
  UPDATE public.users SET role='installer' WHERE id=crew;
  PERFORM pg_temp.refused(first_line,'held_line_reason_required','{}','  ');
  PERFORM pg_temp.refused(first_line,'held_line_above_sent','{"line_total_ex":200.01}');
  PERFORM pg_temp.refused(gen_random_uuid(),'held_line_not_found');
  result := pg_temp.decide(rejected,'query','{}','please explain');
  PERFORM pg_temp.check_true(result#>>'{line,office_review_status}'='queried' AND result#>>'{line,office_review_note}'='please explain'
    AND result#>>'{line,office_reviewed_by}'=staff::text AND result#>>'{line,office_reviewed_at}' IS NOT NULL,'query audit');
  result := pg_temp.decide(rejected,'decline','{}','office declined');
  PERFORM pg_temp.check_true(result#>>'{line,office_review_status}'='rejected' AND result#>>'{line,office_change_reason}'='office declined'
    AND result#>>'{line,trade_invoice_id}'=holding::text AND result#>>'{line,decided_at}' IS NOT NULL,'decline audit');

  -- Change the profile after the original send, then change it again after approval.
  UPDATE public.users SET trade_details='{"gstRegistered":false}' WHERE id=crew;
  -- A failed final read rolls back the money, crew stamp and line move together.
  ALTER FUNCTION public.trade_send_totals(uuid) RENAME TO zztest_0510_totals;
  PERFORM pg_temp.refused(first_line,'held_line_decision_failed');
  ALTER FUNCTION public.zztest_0510_totals(uuid) RENAME TO trade_send_totals;
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.trade_invoices WHERE send_id=send AND invoice_kind='follow_on')
    AND (SELECT self_added_status='not_accepted' FROM public.job_assignments WHERE id=self_booking),'failed read rolled back');
  UPDATE public.trade_invoices SET gst_on=NULL, super_basis=NULL, super_rate=NULL, super_amount=NULL,
    gross_earned=NULL,net_pay=NULL WHERE id=holding;
  PERFORM pg_temp.refused(first_line,'held_line_original_gst_missing');
  UPDATE public.trade_invoices SET gst_on=true,super_basis='inclusive_12_112_v1',super_rate=.12,
    super_amount=0,gross_earned=0,net_pay=0 WHERE id=holding;
  -- Missing data refuses and writes nothing: a job with no approved work order amount,
  -- then a line on the send whose amount cannot be read.
  PERFORM set_config('session_replication_role','replica',true);
  INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES(bare_job,org,'ZZTEST-0510-B','fencing','accepted');
  UPDATE public.trade_invoice_lines SET sent_amount_ex=NULL WHERE id=rejected;
  PERFORM set_config('session_replication_role','origin',true);
  PERFORM pg_temp.refused(first_line,'held_line_job_not_backed',jsonb_build_object('job_id',bare_job));
  PERFORM pg_temp.refused(first_line,'held_line_not_balanced');
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE public.trade_invoice_lines SET sent_amount_ex=10 WHERE id=rejected;
  PERFORM set_config('session_replication_role','origin',true);
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.trade_invoices WHERE send_id=send AND invoice_kind='follow_on')
    AND (SELECT trade_invoice_id=holding AND office_review_status='awaiting' AND job_id=job FROM public.trade_invoice_lines WHERE id=first_line),
    'refusals wrote nothing');
  result := pg_temp.decide(first_line);
  follow_id := (result->>'follow_on_invoice_id')::uuid;
  PERFORM pg_temp.check_true((SELECT invoice_kind='follow_on' AND invoice_number='ZZTEST-0510-F1' AND follows_invoice_id=standard
    AND gst_on AND gross_earned=200 AND super_amount=21.43 AND net_pay=178.57 AND gst=20 AND total_inc=220
    AND week_start='2026-11-23' FROM public.trade_invoices WHERE id=follow_id),'first follow-on and send-time GST');
  PERFORM pg_temp.check_true((SELECT self_added_status='accepted' AND self_added_reviewed_by=staff AND self_added_reviewed_at IS NOT NULL
    FROM public.job_assignments WHERE id=self_booking),'crew accepted');
  PERFORM pg_temp.check_true(result#>'{send,balanced}'='true'::jsonb AND result->>'work_order_change_id' IS NULL,'exact room');
  PERFORM pg_temp.refused(first_line,'held_line_already_decided');
  -- The open follow-on was changed by hand to another GST status: the next approval refuses.
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE public.trade_invoices SET gst_on=false,gst=0,total_inc=200 WHERE id=follow_id;
  PERFORM set_config('session_replication_role','origin',true);
  PERFORM pg_temp.refused(third_line,'held_line_follow_on_changed');
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE public.trade_invoices SET gst_on=true,gst=20,total_inc=220 WHERE id=follow_id;
  PERFORM set_config('session_replication_role','origin',true);
  PERFORM pg_temp.check_true((SELECT trade_invoice_id=holding AND office_review_status='awaiting'
    FROM public.trade_invoice_lines WHERE id=third_line)
    AND NOT EXISTS(SELECT 1 FROM public.work_order_amount_changes WHERE work_order_id=wo),'refused approval left no change');
  SELECT to_jsonb(l) INTO prior_line FROM public.trade_invoice_lines l WHERE id=first_line;
  SELECT gst INTO prior_gst FROM public.trade_invoices WHERE id=follow_id;
  UPDATE public.users SET trade_details='{"gstRegistered":true}' WHERE id=crew;
  -- The office has raised the allowance since send; exactly one cent now separates this approval from the room.
  INSERT INTO public.work_order_amount_changes(org_id,work_order_id,job_id,kind,from_ex,to_ex,delta_ex,changed_by,reason)
    VALUES(org,wo,job,'amount',200,647.99,447.99,staff,'office change');
  -- A different billed invoice already has a zero office override. The common room
  -- rule must count that zero; counting its original amount would raise too much.
  INSERT INTO public.trade_invoices(org_id,user_id,week_start,week_end,invoice_number,status,subtotal_ex,gross_earned,super_amount,
    net_pay,super_rate,gst_on,gst,total_inc,total_hours) VALUES(org,crew,'2026-11-16','2026-11-22','ZZTEST-0510-OTHER',
    'pending_ops_review',0,0,0,0,.12,false,0,0,0) RETURNING id INTO unrelated;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,override_amount,office_review_status)
    VALUES(unrelated,job,'other',1,0,'approved');
  result := pg_temp.decide(second_line,'approve','{"total_hours":8}','approved eight hours');
  PERFORM pg_temp.check_true(result->>'follow_on_invoice_id'=follow_id::text AND (result#>>'{line,sent_values,total_hours}')::numeric=9
    AND (result#>>'{line,line_total_ex}')::numeric=448 AND (result#>>'{send,declined_ex}')::numeric=66,'reduced original');
  PERFORM pg_temp.check_true((SELECT delta_ex=.01 AND changed_by=staff AND reason='approved eight hours'
    FROM public.work_order_amount_changes WHERE id=(result->>'work_order_change_id')::uuid),'one cent shortfall');
  PERFORM pg_temp.check_true((SELECT gst=prior_gst+44.80 AND gross_earned=648 AND super_amount=69.43 AND net_pay=578.57
    FROM public.trade_invoices WHERE id=follow_id) AND (SELECT to_jsonb(l)=prior_line FROM public.trade_invoice_lines l WHERE id=first_line),
    'second approval must preserve first line and its GST');
  PERFORM pg_temp.refused(typed,'approver_required');
  UPDATE public.trade_pay_settings SET pay_run_approver_user_ids=ARRAY[staff],not_job_work_account_code='ZZTEST' WHERE id=1;
  PERFORM pg_temp.refused(typed,'held_line_needs_job_or_type');
  UPDATE public.users SET trade_details='{"gstRegistered":false}' WHERE id=crew;
  result := pg_temp.decide(typed,'approve',jsonb_build_object('not_job_work_type_id',kind));
  PERFORM pg_temp.check_true(result#>>'{line,not_job_work_type_id}'=kind::text,'active kind');
  -- A run already owns F1. Its next accounting document must be F2.
  -- FU49 item 1: take the approved lines through the unmodified weekly approval,
  -- including its real standing checks, and read what will be paid to this trade.
  report := public.trade_pay_run_check_v2('2026-11-30',2,org,'before_xero');
  SELECT entry INTO STRICT checked FROM jsonb_array_elements(report->'invoices') entry
    WHERE entry->>'invoice_id'=follow_id::text;
  PERFORM pg_temp.check_true(checked->>'verdict'='clean' AND checked->'stops'='[]'::jsonb
    AND checked->>'user_id'=crew::text AND (checked->>'invoice_pays')::numeric=650.32
    AND (checked->>'super_amount')::numeric=70.18,'next pay run read of the follow-on');
  result := public.approve_trade_pay_run(org,'2026-11-30',staff,jsonb_build_object(
    'check_rule',report->>'rule','invoices',jsonb_build_array(jsonb_build_object(
    'invoice_id',checked->'invoice_id','verdict',checked->'verdict',
    'pays',checked->'invoice_pays','super_amount',checked->'super_amount'))));
  zz_run_id := (result->>'run_id')::uuid;
  PERFORM pg_temp.check_true((SELECT i.user_id=crew AND i.pay_run_id=r.run_id
    -- The run keeps the invoice's status (20261118163000); its own push moves it to approved.
    AND i.status='pending_ops_review' AND r.verdict='clean'
    AND r.pays=650.32 AND r.super_amount=70.18 AND i.gst=65.50 AND i.gross_earned=655
    FROM public.trade_invoices i JOIN public.trade_pay_run_invoices r ON r.invoice_id=i.id
    WHERE i.id=follow_id AND r.run_id=zz_run_id)
    AND (SELECT count(*)=1 FROM public.trade_pay_run_invoices r WHERE r.run_id=zz_run_id),'normal next pay run');

  INSERT INTO public.work_order_amount_changes(org_id,work_order_id,job_id,kind,from_ex,to_ex,delta_ex,changed_by,reason)
    VALUES(org,wo,job,'amount',648,748,100,staff,'office change');
  result := pg_temp.decide(third_line);
  PERFORM pg_temp.check_true((SELECT invoice_number='ZZTEST-0510-F2' AND gross_earned=300 FROM public.trade_invoices
    WHERE id=(result->>'follow_on_invoice_id')::uuid) AND (SELECT delta_ex=200 FROM public.work_order_amount_changes
    WHERE id=(result->>'work_order_change_id')::uuid),'new follow-on and exact work order change');
  PERFORM pg_temp.refused(commission_line,'held_line_commission_not_known');
  PERFORM set_config('session_replication_role','replica',true);
  INSERT INTO public.job_commissions(job_id,budget_id,version,scope_revision_id,trade,salesperson_user_id,state,expected_amount_ex_gst)
    VALUES(job,gen_random_uuid(),1,gen_random_uuid(),'fence',crew,'named',448);
  PERFORM set_config('session_replication_role','origin',true);
  -- Submit the existing holding row for approval with the original commission cap installed.
  result := pg_temp.decide(commission_line,'approve','{"line_total_ex":999}');
  PERFORM pg_temp.check_true((result#>>'{line,line_total_ex}')::numeric=448 AND (result#>>'{line,sent_amount_ex}')::numeric=448
    AND result#>'{send,balanced}'='true'::jsonb AND result->>'work_order_change_id' IS NULL,'commission from job');
  PERFORM pg_temp.check_true((SELECT gross_earned=748 AND super_amount=80.14 AND net_pay=667.86 AND gst=74.8
    FROM public.trade_invoices WHERE id=(result->>'follow_on_invoice_id')::uuid),'commission inclusive split');
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,sent_amount_ex,total_hours,hourly_rate,
    quantity,unit_rate,office_review_status,hold_reason)
    VALUES(holding,job,'labour',48,48,4,12,4,12,'awaiting','over_amount') RETURNING id INTO explicit_line;
  result := pg_temp.decide(explicit_line,'approve','{"total_hours":3,"line_total_ex":48}');
  PERFORM pg_temp.check_true((SELECT line_total_ex=48 AND total_hours=3 AND hourly_rate=0 AND unit_rate=0
    AND (sent_values->>'hourly_rate')::numeric=12 AND (sent_values->>'total_hours')::numeric=4
    FROM public.trade_invoice_lines WHERE id=explicit_line),'explicit amount and changed hours agree on the bill');
  INSERT INTO public.expense_receipts(receipt_photo_url) VALUES('ZZTEST-0510-receipt') RETURNING id INTO receipt;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,sent_amount_ex,office_review_status,hold_reason,expense_receipt_id)
    VALUES(holding,job,'reimbursement',20,20,'awaiting','reimbursement',receipt) RETURNING id INTO receipt_line;
  result := pg_temp.decide(receipt_line);
  PERFORM pg_temp.check_true(result->>'work_order_change_id' IS NULL AND (SELECT gross_earned=816 AND super_base_ex=796
    AND super_amount=85.29 AND net_pay=730.71 AND gst=79.60 AND total_inc=895.60
    FROM public.trade_invoices WHERE id=(result->>'follow_on_invoice_id')::uuid),'reimbursement excluded from GST and super');
  PERFORM pg_temp.check_true((SELECT to_jsonb(i)=original_standard FROM public.trade_invoices i WHERE id=standard),'standard invoice unchanged');
END $$;
\ir plans.sql
ROLLBACK;
\echo P1-05.10 held decision and follow-on contract passed
