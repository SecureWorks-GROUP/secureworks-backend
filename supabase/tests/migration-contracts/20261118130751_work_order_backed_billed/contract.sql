BEGIN;
SET LOCAL statement_timeout='90s';
-- Restore and reapply the exact definitions inside this transaction.
SELECT public.remove_trade_line_job_amount_guard();
\ir ../../../rollbacks/20261118130751_work_order_backed_billed_down.sql
-- Simulate an installation from before override-only edits fired the guard.
SELECT public.install_trade_line_job_amount_guard();
\ir ../../../migrations/20261118130751_work_order_backed_billed.sql
SET LOCAL session_replication_role=replica;
\ir ../20261118070639_trade_line_job_amount_guard/fixture.sql
SET LOCAL lock_timeout='0';
SELECT public.install_trade_line_job_amount_guard();
SELECT public.install_trade_line_job_amount_guard();
ALTER TABLE public.trade_invoice_lines ENABLE ALWAYS TRIGGER trade_invoice_lines_job_amount_guard;
ALTER TABLE public.trade_invoices ENABLE ALWAYS TRIGGER trade_invoices_job_amount_guard;

CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %',label; END IF;
END $$;
CREATE FUNCTION pg_temp.expect_guard(cmd text, job uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE detail text; BEGIN
  EXECUTE cmd;
  RAISE EXCEPTION 'ZZTEST missing refusal';
EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
  IF SQLERRM<>'job_amount_guard' OR detail IS DISTINCT FROM job::text THEN RAISE; END IF;
END $$;

DO $$ DECLARE
  j uuid:='f1050900-0000-4000-8000-000000000001';
  i uuid:='f1050900-0000-4000-8000-000000000004';
  h uuid:='f1050900-0000-4000-8000-000000000005';
  missing_job uuid:=gen_random_uuid();
  first_line uuid; second_line uuid; st text;
BEGIN
  PERFORM pg_temp.assert_ok(current_setting('lock_timeout')='5s','install lock timeout');
  PERFORM pg_temp.assert_ok(NOT has_function_privilege('authenticated','public.work_order_backed_billed(uuid[],uuid[])','EXECUTE')
    AND has_function_privilege('service_role','public.work_order_backed_billed(uuid[],uuid[])','EXECUTE'),'RPC access');

  UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_line_hold_v1';
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,override_amount)
    VALUES(i,j,'labour',10,120.01) RETURNING id INTO first_line;
  UPDATE public.trade_invoice_lines SET override_amount=30 WHERE id=first_line;
  UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_line_hold_v1';

  FOREACH st IN ARRAY public.job_work_order_billed_invoice_statuses() LOOP
    UPDATE public.trade_invoices SET status=st WHERE id=i;
    PERFORM pg_temp.assert_ok(public.job_backed_room(j)=90,'billed status or override incorrect');
  END LOOP;
  -- A new invoice status is outside the catalogue even if it is neither draft nor rejected.
  PERFORM pg_temp.assert_ok(NOT public.work_order_backed_invoice('unlisted','standard'),'unlisted status counted');
  FOREACH st IN ARRAY ARRAY['draft','ops-reject'] LOOP
    UPDATE public.trade_invoices SET status=st WHERE id=i;
    PERFORM pg_temp.assert_ok(public.job_backed_room(j)=120,'excluded invoice counted');
  END LOOP;
  UPDATE public.trade_invoices SET status='paid' WHERE id=i;
  UPDATE public.trade_invoices SET invoice_kind='held' WHERE id=h;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
    VALUES(h,j,'labour',200) RETURNING id INTO second_line;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,office_review_status)
    VALUES(i,j,'labour',200,'awaiting');
  PERFORM pg_temp.assert_ok(public.job_backed_room(j)=90,'held invoice or held line spent room');
  DELETE FROM public.trade_invoice_lines WHERE id=second_line;
  UPDATE public.trade_invoices SET invoice_kind='follow_on' WHERE id=h;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,override_amount)
    VALUES(h,j,'labour',500,90) RETURNING id INTO second_line;
  PERFORM pg_temp.assert_ok(public.job_backed_room(j)=0,'exact fit refused or wrong room');
  PERFORM pg_temp.assert_ok((SELECT billed_ex=30 FROM public.work_order_backed_billed(ARRAY[j],ARRAY[second_line])),
    'replacement lines counted twice');
  PERFORM pg_temp.expect_guard(format('UPDATE public.trade_invoice_lines SET override_amount=90.01 WHERE id=%L',second_line),j);
  PERFORM pg_temp.expect_guard(format('UPDATE public.trade_invoice_lines SET override_amount=NULL WHERE id=%L',second_line),j);
  PERFORM pg_temp.assert_ok((SELECT override_amount=90 FROM public.trade_invoice_lines WHERE id=second_line),'refusal changed saved override');
  UPDATE public.trade_invoice_lines SET override_amount=0 WHERE id=first_line;
  PERFORM pg_temp.assert_ok(public.job_backed_room(j)=30,'explicit zero fell back to line total');
  UPDATE public.trade_invoice_lines SET override_amount=90.01 WHERE id=second_line;
  UPDATE public.trade_invoice_lines SET override_amount=NULL WHERE id=first_line;
  PERFORM pg_temp.assert_ok(public.job_backed_room(j)=19.99,'retry or raw fallback failed');

  UPDATE public.trade_invoices SET status='draft' WHERE id=h;
  UPDATE public.trade_invoice_lines SET line_total_ex=1,override_amount=110.01 WHERE id=second_line;
  PERFORM pg_temp.expect_guard(format('UPDATE public.trade_invoices SET status=%L WHERE id=%L','pending_ops_review',h),j);
  PERFORM pg_temp.assert_ok((SELECT status='draft' FROM public.trade_invoices WHERE id=h),'header refusal was not atomic');
  UPDATE public.trade_invoice_lines SET override_amount=110 WHERE id=second_line;
  UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id=h;
  PERFORM pg_temp.assert_ok(public.job_backed_room(j)=0,'header retry at exact cap');

  PERFORM pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.work_order_backed_billed(ARRAY[missing_job])),
    'unknown job returned a billed total');
  PERFORM pg_temp.assert_ok(public.job_backed_room(missing_job) IS NULL,'missing work order returned zero');
  PERFORM pg_temp.expect_guard(format('INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(%L,%L,%L,0.01)',h,missing_job,'labour'),missing_job);
END $$;

-- Exercise the aggregate's actual query with unrelated rows present. Its SQL
-- function is inlined, so the plan exposes the line and invoice reads.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_line_hold_v1';
INSERT INTO public.jobs(id,org_id,type,status,job_number)
SELECT gen_random_uuid(),'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-CAP-'||n
FROM generate_series(1,3000) n;
INSERT INTO public.trade_invoices(id,org_id,user_id,invoice_number,week_start,week_end,total_hours,
 status,invoice_kind,subtotal_ex,gst,total_inc,gst_on,super_rate,super_amount,gross_earned,net_pay)
SELECT gen_random_uuid(),'00000000-0000-0000-0000-000000000001',gen_random_uuid(),'ZZTEST-CAP-'||n,
 '2026-11-16'::date,'2026-11-22'::date,0,'paid','standard',0,0,0,false,0.12,0,0,0
FROM generate_series(1,3000) n;
INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
SELECT id,gen_random_uuid(),'labour',0 FROM public.trade_invoices WHERE invoice_number LIKE 'ZZTEST-CAP-%';
ANALYZE public.jobs;
ANALYZE public.trade_invoice_lines;
ANALYZE public.trade_invoices;
DO $$ DECLARE plan jsonb; rel text; BEGIN
  EXECUTE $q$EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM public.work_order_backed_billed(
    ARRAY['f1050900-0000-4000-8000-000000000001'::uuid])$q$ INTO plan;
  FOREACH rel IN ARRAY ARRAY['jobs','trade_invoices','trade_invoice_lines'] LOOP
    PERFORM pg_temp.assert_ok(jsonb_path_exists(plan,
      '$.** ? (@."Relation Name" == $r && (@."Node Type" == "Index Scan" || @."Node Type" == "Bitmap Heap Scan" || @."Node Type" == "Index Only Scan"))',
      jsonb_build_object('r',rel)),'unbounded billed read on '||rel);
  END LOOP;
  PERFORM pg_temp.assert_ok(NOT jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Seq Scan" || @."Actual Rows" > 10 || @."Rows Removed by Filter" > 10)'),'billed read scanned unrelated rows');
END $$;
ROLLBACK;
SELECT 'P1-05.9 shared billed room contract passed' AS result;
