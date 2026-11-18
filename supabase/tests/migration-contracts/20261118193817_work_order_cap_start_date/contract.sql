BEGIN;
SET LOCAL statement_timeout='90s';
-- Rule 17: re-apply this migration inside the rolled-back contract (its table and
-- function are created with plain CREATE, so the rollback runs first).
SELECT public.remove_trade_line_job_amount_guard();
\ir ../../../rollbacks/20261118193817_work_order_cap_start_date_down.sql
\ir ../../../migrations/20261118193817_work_order_cap_start_date.sql

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
CREATE FUNCTION pg_temp.scoped(job uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT s.in_scope FROM public.work_order_cap_scope(ARRAY[job]) s
$$;

-- What runs on merge: one row seeded with no start date, nothing installed, switch untouched.
DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT count(*)=1 AND bool_and(cap_start_on IS NULL)
    FROM public.work_order_cap_settings),'settings seeded with a start date');
  PERFORM pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN
    ('trade_invoice_lines_job_amount_guard','trade_invoices_job_amount_guard') AND NOT tgisinternal),'guard installed on merge');
  PERFORM pg_temp.assert_ok(EXISTS(SELECT 1 FROM public.feature_flags
    WHERE flag_name='trade_line_hold_v1' AND NOT enabled),'hold switch must stay off');
  PERFORM pg_temp.assert_ok((SELECT relrowsecurity FROM pg_class WHERE oid='public.work_order_cap_settings'::regclass),'settings RLS off');
  PERFORM pg_temp.assert_ok(NOT has_table_privilege('anon','public.work_order_cap_settings','SELECT')
    AND NOT has_table_privilege('authenticated','public.work_order_cap_settings','SELECT')
    AND NOT has_table_privilege('authenticated','public.work_order_cap_settings','UPDATE')
    AND has_table_privilege('service_role','public.work_order_cap_settings','SELECT'),'settings access');
  PERFORM pg_temp.assert_ok(NOT has_function_privilege('authenticated','public.work_order_cap_scope(uuid[])','EXECUTE')
    AND NOT has_function_privilege('anon','public.work_order_cap_scope(uuid[])','EXECUTE')
    AND has_function_privilege('service_role','public.work_order_cap_scope(uuid[])','EXECUTE'),'scope RPC access');
  PERFORM pg_temp.assert_ok(NOT has_function_privilege('service_role','public.trade_invoice_lines_job_amount_guard()','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.trade_invoices_job_amount_guard()','EXECUTE'),'guard grants changed');
END $$;

SET LOCAL session_replication_role=replica;
\ir ../20261118070639_trade_line_job_amount_guard/fixture.sql
SET LOCAL lock_timeout='0';
SELECT public.install_trade_line_job_amount_guard();
ALTER TABLE public.trade_invoice_lines ENABLE ALWAYS TRIGGER trade_invoice_lines_job_amount_guard;
ALTER TABLE public.trade_invoices ENABLE ALWAYS TRIGGER trade_invoices_job_amount_guard;

DO $$ DECLARE
  j uuid:='f1050900-0000-4000-8000-000000000001';
  wo uuid:='f1050900-0000-4000-8000-000000000002';
  i uuid:='f1050900-0000-4000-8000-000000000004';
  h uuid:='f1050900-0000-4000-8000-000000000005';
  old_j uuid:='f1050900-0000-4000-8000-0000000000a1';
  draft_j uuid:='f1050900-0000-4000-8000-0000000000a2';
  bare_j uuid:='f1050900-0000-4000-8000-0000000000a3';
  new_draft_j uuid:='f1050900-0000-4000-8000-0000000000a4';
  new_bare_j uuid:='f1050900-0000-4000-8000-0000000000a5';
  unknown_j uuid:=gen_random_uuid();
  l uuid; n int;
BEGIN
  -- Old jobs (created long ago): one approved long ago, one with a draft order, one with no
  -- order. New jobs (created now): one with a draft order, one with no order. The fixture job
  -- was created long ago and its order is approved now.
  UPDATE public.jobs SET created_at='2026-09-01 01:00:00+00' WHERE id=j;
  INSERT INTO public.jobs(id,org_id,type,status,job_number,created_at) VALUES
    (old_j,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-SCOPE-OLD','2026-09-01 01:00:00+00'),
    (draft_j,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-SCOPE-DRAFT','2026-09-01 01:00:00+00'),
    (bare_j,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-SCOPE-BARE','2026-09-01 01:00:00+00'),
    (new_draft_j,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-SCOPE-NEW-DRAFT',now()),
    (new_bare_j,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-SCOPE-NEW-BARE',now());
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,approved_at,approved_by,sealed_content_hash) VALUES
    (gen_random_uuid(),'00000000-0000-0000-0000-000000000001',old_j,'ZZTEST-SCOPE-OLD-WO','job','approved',50,
     '2026-10-01 01:00:00+00','f1050900-0000-4000-8000-000000000003','ZZTEST sealed'),
    (gen_random_uuid(),'00000000-0000-0000-0000-000000000001',draft_j,'ZZTEST-SCOPE-DRAFT-WO','job','draft',50,
     NULL,NULL,NULL),
    (gen_random_uuid(),'00000000-0000-0000-0000-000000000001',new_draft_j,'ZZTEST-SCOPE-NEW-DRAFT-WO','job','draft',50,
     NULL,NULL,NULL);

  -- Null start date: no job is in scope, whatever its order.
  PERFORM pg_temp.assert_ok(NOT pg_temp.scoped(j) AND NOT pg_temp.scoped(old_j) AND NOT pg_temp.scoped(draft_j)
    AND NOT pg_temp.scoped(bare_j) AND NOT pg_temp.scoped(new_draft_j) AND NOT pg_temp.scoped(new_bare_j)
    AND NOT pg_temp.scoped(unknown_j),'null start date scoped a job');
  -- One row per distinct requested id; nulls skipped; unknown jobs answered false.
  SELECT count(*) INTO n FROM public.work_order_cap_scope(ARRAY[j,j,NULL,unknown_j,old_j]);
  PERFORM pg_temp.assert_ok(n=3,'scope rows not one per distinct id');
  PERFORM pg_temp.assert_ok(NOT EXISTS(SELECT 1 FROM public.work_order_cap_scope(ARRAY[]::uuid[])),'empty request answered');

  -- Switch off: an over-room line is saved whatever the start date, exactly as on main.
  UPDATE public.work_order_cap_settings SET cap_start_on='2000-01-01';
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'labour',999) RETURNING id INTO l;
  DELETE FROM public.trade_invoice_lines WHERE id=l;

  -- Switch on, null start date: no job is capped, line or header.
  UPDATE public.work_order_cap_settings SET cap_start_on=NULL;
  UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_line_hold_v1';
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'labour',999) RETURNING id INTO l;
  UPDATE public.trade_invoice_lines SET line_total_ex=1999 WHERE id=l;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,bare_j,'labour',5);
  UPDATE public.trade_invoices SET status='draft' WHERE id=h;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(h,j,'labour',500),(h,bare_j,'labour',5);
  UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id=h;
  -- A missing settings row is the same as no start date.
  DELETE FROM public.work_order_cap_settings;
  PERFORM pg_temp.assert_ok(NOT pg_temp.scoped(j),'missing settings row scoped a job');
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'labour',1);
  INSERT INTO public.work_order_cap_settings(id,cap_start_on) VALUES(1,NULL);
  DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id IN(i,h);
  UPDATE public.trade_invoices SET status='pending_ops_review',invoice_kind='standard' WHERE id IN(i,h);

  -- Start date on the approval's Perth day: in scope, capped exactly as 20261118153101.
  UPDATE public.work_order_cap_settings SET cap_start_on=(now() AT TIME ZONE 'Australia/Perth')::date;
  PERFORM pg_temp.assert_ok(pg_temp.scoped(j),'job approved on the start day not scoped');
  PERFORM pg_temp.assert_ok(NOT pg_temp.scoped(old_j) AND NOT pg_temp.scoped(draft_j) AND NOT pg_temp.scoped(bare_j),
    'older, draft or bare job scoped');
  -- Ruling (b): a job created on or after the start date with no approved order (none, or a
  -- draft) is in scope, so its lines still go to the office; a job that cannot be read too.
  PERFORM pg_temp.assert_ok(pg_temp.scoped(new_draft_j) AND pg_temp.scoped(new_bare_j) AND pg_temp.scoped(unknown_j),
    'new job with no approved order released');
  PERFORM pg_temp.expect_guard(format('INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(%L,%L,%L,1)',i,new_draft_j,'labour'),new_draft_j);
  PERFORM pg_temp.expect_guard(format('INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(%L,%L,%L,1)',i,new_bare_j,'labour'),new_bare_j);
  -- An approved order decides by its approval day even on a new job.
  UPDATE public.work_orders SET status='approved',approved_at='2026-10-01 01:00:00+00',
    approved_by='f1050900-0000-4000-8000-000000000003',sealed_content_hash='ZZTEST sealed' WHERE job_id=new_draft_j;
  PERFORM pg_temp.assert_ok(NOT pg_temp.scoped(new_draft_j),'new job approved before the start day scoped');
  UPDATE public.work_orders SET status='draft',approved_at=NULL,approved_by=NULL,sealed_content_hash=NULL WHERE job_id=new_draft_j;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'labour',120) RETURNING id INTO l;
  PERFORM pg_temp.expect_guard(format('INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(%L,%L,%L,0.01)',h,j,'labour'),j);
  PERFORM pg_temp.expect_guard(format('UPDATE public.trade_invoice_lines SET line_total_ex=120.01 WHERE id=%L',l),j);
  -- Older, draft-order and bare jobs hold nothing beside it, line or header.
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
    VALUES(i,old_j,'labour',999),(i,draft_j,'labour',999),(i,bare_j,'labour',999);
  UPDATE public.trade_invoices SET status='draft' WHERE id=h;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(h,old_j,'labour',999),(h,bare_j,'labour',999);
  UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id=h;
  -- A header holding an out-of-scope job and an over in-scope job is still refused for the
  -- in-scope one, and the refusal leaves the header as it was.
  UPDATE public.trade_invoices SET status='draft' WHERE id=h;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(h,j,'labour',0.01);
  PERFORM pg_temp.expect_guard(format('UPDATE public.trade_invoices SET status=%L WHERE id=%L','pending_ops_review',h),j);
  PERFORM pg_temp.assert_ok((SELECT status='draft' FROM public.trade_invoices WHERE id=h),'header refusal not atomic');
  -- Retry after the start date moves past the approval: the job leaves scope and the move is saved.
  UPDATE public.work_order_cap_settings SET cap_start_on=(now() AT TIME ZONE 'Australia/Perth')::date+1;
  PERFORM pg_temp.assert_ok(NOT pg_temp.scoped(j),'job approved before the start day scoped');
  UPDATE public.trade_invoices SET status='pending_ops_review' WHERE id=h;
  DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id IN(i,h);

  -- Perth day boundary. 16:30 UTC on 17 Nov is 00:30 Perth on 18 Nov; 15:59:59 UTC is
  -- 23:59:59 Perth on 17 Nov. A UTC comparison would read both as 17 Nov.
  UPDATE public.work_order_cap_settings SET cap_start_on='2026-11-18';
  UPDATE public.work_orders SET approved_at='2026-11-17 16:30:00+00' WHERE id=wo;
  PERFORM pg_temp.assert_ok(pg_temp.scoped(j),'Perth start day read as UTC');
  UPDATE public.work_orders SET approved_at='2026-11-17 15:59:59+00' WHERE id=wo;
  PERFORM pg_temp.assert_ok(NOT pg_temp.scoped(j),'Perth day before read as start day');
  -- An order taken back to draft falls to the job's creation day (an old job here).
  UPDATE public.work_orders SET approved_at='2026-11-18 01:00:00+00' WHERE id=wo;
  PERFORM pg_temp.assert_ok(pg_temp.scoped(j),'order approved after start not scoped');
  UPDATE public.work_orders SET status='draft' WHERE id=wo;
  PERFORM pg_temp.assert_ok(NOT pg_temp.scoped(j),'draft order on an old job scoped');
  UPDATE public.work_orders SET status='approved' WHERE id=wo;
  -- The creation day is a Perth day too, on a job with no approved order.
  UPDATE public.jobs SET created_at='2026-11-17 16:30:00+00' WHERE id=bare_j;
  PERFORM pg_temp.assert_ok(pg_temp.scoped(bare_j),'Perth creation day read as UTC');
  UPDATE public.jobs SET created_at='2026-11-17 15:59:59+00' WHERE id=bare_j;
  PERFORM pg_temp.assert_ok(NOT pg_temp.scoped(bare_j),'Perth day before creation read as start day');
  -- A creation time that cannot be read holds, never releases (only if the column allows null).
  IF (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid='public.jobs'::regclass AND attname='created_at') THEN
    UPDATE public.jobs SET created_at=NULL WHERE id=bare_j;
    PERFORM pg_temp.assert_ok(pg_temp.scoped(bare_j),'unknown creation day released');
    UPDATE public.jobs SET created_at='2026-09-01 01:00:00+00' WHERE id=bare_j;
  END IF;

  -- Switch off again with a start date set: the same over-room write is saved, as on main.
  UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_line_hold_v1';
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(i,j,'labour',999);
END $$;

-- The scope read is index-bound: its live body planned against 3,000 unrelated jobs and job
-- work orders.
INSERT INTO public.jobs(id,org_id,type,status,job_number,created_at)
SELECT gen_random_uuid(),'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-SCOPE-PLAN-'||n,now()
FROM generate_series(1,3000) n;
INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex)
SELECT gen_random_uuid(),'00000000-0000-0000-0000-000000000001',id,job_number,'job','draft',0
FROM public.jobs WHERE job_number LIKE 'ZZTEST-SCOPE-PLAN-%';
UPDATE public.work_order_cap_settings SET cap_start_on='2026-11-18';
ANALYZE public.jobs;
ANALYZE public.work_orders;
ANALYZE public.work_order_cap_settings;
DO $$ DECLARE plan jsonb; body text; BEGIN
  SELECT p.prosrc INTO body FROM pg_proc p WHERE p.oid='public.work_order_cap_scope(uuid[])'::regprocedure;
  body:=replace(body,'p_job_ids',$v$ARRAY['f1050900-0000-4000-8000-000000000001'::uuid,'f1050900-0000-4000-8000-0000000000a1'::uuid]$v$);
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) '||body INTO plan;
  PERFORM pg_temp.assert_ok(jsonb_path_exists(plan,
    '$.** ? (@."Relation Name" == "work_orders" && (@."Node Type" == "Index Scan" || @."Node Type" == "Bitmap Heap Scan" || @."Node Type" == "Index Only Scan"))'),
    'scope read not index-bound on work_orders');
  PERFORM pg_temp.assert_ok(NOT jsonb_path_exists(plan,
    '$.** ? ((@."Relation Name" == "work_orders" || @."Relation Name" == "jobs") && @."Node Type" == "Seq Scan")'),
    'scope read scanned work_orders or jobs');
  PERFORM pg_temp.assert_ok(NOT jsonb_path_exists(plan,'$.** ? (@."Actual Rows" > 10 || @."Rows Removed by Filter" > 10)'),
    'scope read touched unrelated rows');
END $$;
ROLLBACK;
SELECT 'FU49-9b work order cap start date contract passed' AS result;
