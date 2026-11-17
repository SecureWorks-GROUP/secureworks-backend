BEGIN;
SET LOCAL statement_timeout='120s';
-- Rule 17: reapply our creating migration inside the rolled-back contract.
\ir ../../../migrations/20261118061824_trade_line_job_amount_guard.sql
CREATE FUNCTION pg_temp.zztest_assert(ok boolean, words text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %',words; END IF;
END $$;
CREATE FUNCTION pg_temp.zztest_guard_refuses(command text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM='job_amount_guard' THEN RETURN; END IF;
  RAISE;
 END;
 RAISE EXCEPTION 'ZZTEST expected job_amount_guard';
END $$;
-- Prove merge does not install on a business table or change the flag.
SELECT pg_temp.zztest_assert(NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.trade_invoice_lines'::regclass
 AND tgname='trade_invoice_lines_job_amount_guard'),'guard installed on merge');
SELECT pg_temp.zztest_assert(EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='trade_line_hold_v1' AND NOT enabled),'hold switch must stay off');
SET LOCAL session_replication_role=replica;
\ir fixture.sql
SELECT public.install_trade_line_job_amount_guard();
SELECT public.install_trade_line_job_amount_guard();
-- Isolate this guard from unrelated existing business triggers. Transaction rollback restores all settings.
ALTER TABLE public.trade_invoice_lines ENABLE ALWAYS TRIGGER trade_invoice_lines_job_amount_guard;
DO $$ DECLARE j uuid:='f1050900-0000-4000-8000-000000000001';
 i uuid:='f1050900-0000-4000-8000-000000000004';
 other_i uuid:='f1050900-0000-4000-8000-000000000005';
 l uuid; held uuid; BEGIN
 -- Off: even an over-room line is saved, exactly as before this change.
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'labour',999) RETURNING id INTO l;
 DELETE FROM public.trade_invoice_lines WHERE id=l;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_line_hold_v1';
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=120,'initial room');
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'labour',120) RETURNING id INTO l;
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=0,'backed amount not counted');
 -- Director ruling: whole cents above allowed is over, with no tolerance.
 PERFORM pg_temp.zztest_guard_refuses(format('INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(%L,%L,%L,0.01)',other_i,j,'labour'));
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,office_review_status)
 VALUES(other_i,j,'labour',999,'awaiting') RETURNING id INTO held;
 PERFORM pg_temp.zztest_guard_refuses(format('UPDATE public.trade_invoice_lines SET office_review_status=%L WHERE id=%L','approved',held));
 PERFORM pg_temp.zztest_assert((SELECT office_review_status='awaiting' FROM public.trade_invoice_lines WHERE id=held),'refusal changed held line');
 UPDATE public.trade_invoice_lines SET office_review_status='queried' WHERE id=held;
 DELETE FROM public.trade_invoice_lines WHERE id=held;
 -- Updating the same counted row gives back its own old amount, never another job's.
 UPDATE public.trade_invoice_lines SET line_total_ex=120,office_review_status='approved' WHERE id=l;
 PERFORM pg_temp.zztest_guard_refuses(format('UPDATE public.trade_invoice_lines SET line_total_ex=120.01 WHERE id=%L',l));
 UPDATE public.trade_invoice_lines SET line_total_ex=100 WHERE id=l;
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=20,'reduction not reflected');
 -- An office change is read fresh; retrying a refused line succeeds only once it fits.
 INSERT INTO public.work_order_amount_changes(org_id,work_order_id,job_id,kind,from_ex,to_ex,delta_ex,reason,changed_by)
 VALUES('00000000-0000-0000-0000-000000000001','f1050900-0000-4000-8000-000000000002',j,'amount',120,150,30,'ZZTEST office change','f1050900-0000-4000-8000-000000000003');
 UPDATE public.trade_invoice_lines SET line_total_ex=120.01 WHERE id=l;
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=29.99,'office change or retry wrong');
 DELETE FROM public.trade_invoice_lines WHERE id=l;
 -- Two rows in one statement must see each other's spend, too.
 BEGIN
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
  VALUES(i,j,'labour',100),(i,j,'labour',100);
  RAISE EXCEPTION 'ZZTEST multi-row overage admitted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'job_amount_guard' THEN RAISE; END IF; END;
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=150,'multi-row refusal left partial write');
 -- Only approved customer variation labour is added.
 INSERT INTO public.work_order_customer_variations(org_id,job_id,work_order_id,status,description,created_by,
 variation_number,approved_at,approved_by,trade_allocation_ex,customer_price_ex,sealed_content_hash)
 VALUES('00000000-0000-0000-0000-000000000001',j,'f1050900-0000-4000-8000-000000000002','approved','ZZTEST approved variation','ZZTEST office',
 1,now(),'f1050900-0000-4000-8000-000000000003',20,20,'ZZTEST sealed'),
 ('00000000-0000-0000-0000-000000000001',j,'f1050900-0000-4000-8000-000000000002','draft','ZZTEST draft variation','ZZTEST office',
 NULL,NULL,NULL,999,NULL,NULL);
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=170,'variation status or amount wrong');
 DELETE FROM public.work_order_customer_variations WHERE job_id=j;
 -- Excluded types and invoice kinds/states do not spend the room.
 -- A reimbursement line must name a receipt (main's reimbursement check); the made-up id is not
 -- foreign-key checked while this contract runs as replica.
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,expense_receipt_id)
 VALUES(i,j,'commission',999,NULL),(i,j,'reimbursement',999,'f1050900-0000-4000-8000-000000000007');
 UPDATE public.trade_invoices SET status='draft' WHERE id=other_i;
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(other_i,j,'labour',999);
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=150,'excluded lines spent room');
 DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id IN(i,other_i);
 -- Changing a formerly excluded type cannot bypass the counted-line check.
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'commission',999) RETURNING id INTO l;
 PERFORM pg_temp.zztest_guard_refuses(format('UPDATE public.trade_invoice_lines SET line_type=%L WHERE id=%L','labour',l));
 DELETE FROM public.trade_invoice_lines WHERE id=l;
 UPDATE public.trade_invoices SET status='pending_ops_review',invoice_kind='held' WHERE id=other_i;
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,office_review_status)
 VALUES(other_i,j,'labour',999,'approved');
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=150,'holding invoice counted');
 DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id=other_i;
 UPDATE public.trade_invoices SET invoice_kind='follow_on' WHERE id=other_i;
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,office_review_status)
 VALUES(other_i,j,'labour',150,'approved');
 PERFORM pg_temp.zztest_assert(public.job_backed_room(j)=0,'follow-on not counted');
 -- Missing approved amount refuses a backed line and leaves no partial write.
 PERFORM pg_temp.zztest_guard_refuses(format('INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(%L,%L,%L,1)',i,'f1050900-0000-4000-8000-000000000099','labour'));
 -- Unreadable facts must not become room. The induced local fault is rolled back.
 BEGIN
  ALTER TABLE public.work_order_customer_variations RENAME COLUMN trade_allocation_ex TO zztest_unreadable;
  BEGIN
   INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'labour',1);
   RAISE EXCEPTION 'ZZTEST read fault admitted line';
  EXCEPTION WHEN undefined_column THEN NULL; END;
  RAISE EXCEPTION 'ZZTEST restore fault';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'ZZTEST restore fault' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.zztest_assert((SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id=i)=0,'failed read left line');
END $$;
-- Real plans against a larger unrelated population, without forcing planner settings.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_line_hold_v1';
INSERT INTO public.trade_invoices(id,org_id,user_id,invoice_number,week_start,week_end,total_hours,status,
 invoice_kind,subtotal_ex,gst,total_inc,gst_on,super_rate,super_amount,gross_earned,net_pay)
SELECT gen_random_uuid(),'00000000-0000-0000-0000-000000000001',gen_random_uuid(),'ZZTEST-INDEX-'||n,
 '2026-11-16'::date,'2026-11-22'::date,0,'pending_ops_review','standard',0,0,0,false,0.12,0,0,0
FROM generate_series(1,3000) n;
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
SELECT id,gen_random_uuid(),'labour',0 FROM public.trade_invoices WHERE invoice_number LIKE 'ZZTEST-INDEX-%';
INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex)
SELECT gen_random_uuid(),'00000000-0000-0000-0000-000000000001',gen_random_uuid(),'ZZTEST-INDEX-'||n,'job','draft',0
FROM generate_series(1,3000) n;
INSERT INTO public.work_order_customer_variations(org_id,job_id,work_order_id,status,description,created_by,trade_allocation_ex)
SELECT org_id,job_id,id,'draft','ZZTEST plan fixture','ZZTEST office',0 FROM public.work_orders WHERE wo_number LIKE 'ZZTEST-INDEX-%';
INSERT INTO public.work_order_amount_changes(org_id,work_order_id,job_id,kind,from_ex,to_ex,delta_ex,reason,changed_by)
SELECT org_id,id,job_id,'amount',0,0,0,'ZZTEST plan fixture','f1050900-0000-4000-8000-000000000003'
FROM public.work_orders WHERE wo_number LIKE 'ZZTEST-INDEX-%';
ANALYZE public.trade_invoice_lines;
ANALYZE public.trade_invoices;
ANALYZE public.work_orders;
ANALYZE public.work_order_customer_variations;
ANALYZE public.work_order_amount_changes;
DO $$ DECLARE plan jsonb; query text; BEGIN
 FOREACH query IN ARRAY ARRAY[
  $q$SELECT sum(l.line_total_ex) FROM public.trade_invoice_lines l JOIN public.trade_invoices i ON i.id=l.trade_invoice_id
   WHERE l.job_id='f1050900-0000-4000-8000-000000000001'
   AND lower(btrim(coalesce(l.line_type,''))) NOT IN ('commission','reimbursement')
   AND (l.office_review_status IS NULL OR l.office_review_status='approved')
   AND i.status NOT IN ('draft','ops-reject') AND i.invoice_kind IN ('standard','follow_on')$q$,
  $q$SELECT agreed_labour_ex FROM public.work_orders WHERE job_id='f1050900-0000-4000-8000-000000000001'
    AND kind='job' AND status='approved' AND agreed_labour_ex IS NOT NULL$q$,
  $q$SELECT sum(trade_allocation_ex) FROM public.work_order_customer_variations WHERE work_order_id='f1050900-0000-4000-8000-000000000002' AND status='approved'$q$,
  $q$SELECT coalesce(sum(delta_ex),0) FROM public.work_order_amount_changes WHERE work_order_id='f1050900-0000-4000-8000-000000000002'$q$
 ] LOOP
  EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) '||query INTO plan;
  PERFORM pg_temp.zztest_assert(NOT jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Seq Scan")'),'job query scanned a table');
  PERFORM pg_temp.zztest_assert(NOT jsonb_path_exists(plan,'$.** ? (@."Actual Rows" > 10 || @."Rows Removed by Filter" > 10)'),'job query read unrelated rows');
  PERFORM pg_temp.zztest_assert(jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Index Scan")'),'job query used no index');
 END LOOP;
END $$;
SELECT public.remove_trade_line_job_amount_guard();
SELECT public.remove_trade_line_job_amount_guard();
SELECT pg_temp.zztest_assert(NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trade_invoice_lines_job_amount_guard' AND tgrelid='public.trade_invoice_lines'::regclass),'remove left guard');
SELECT pg_temp.zztest_assert(NOT has_function_privilege('anon','public.job_backed_room(uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.job_backed_room(uuid)','EXECUTE')
 AND has_function_privilege('service_role','public.job_backed_room(uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role','public.install_trade_line_job_amount_guard()','EXECUTE'),'guard privileges');
SELECT 'ZZTEST P1-05.9 contract passed' AS result;
ROLLBACK;
