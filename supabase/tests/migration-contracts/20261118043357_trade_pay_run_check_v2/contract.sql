\echo == P1-08.1 pay-run v2 money and refusal contract ==
BEGIN;
SET LOCAL statement_timeout = '120s';
\ir ../../../migrations/20261118043357_trade_pay_run_check_v2.sql
-- Ignore unrelated write guards only inside this rolled-back read-model fixture.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['users','jobs','trade_invoices','trade_invoice_lines','work_orders',
    'trade_pay_settings','feature_flags','expense_receipts','job_commissions',
    'trade_recurring_deductions','work_order_customer_variations','group_work_orders','group_work_order_shares'] LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER',t);
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass AND contype IN ('f','c','u','x')
      AND NOT (t='feature_flags' AND contype='u') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',t)::regclass
      AND attnum>0 AND NOT attisdropped AND attnotnull AND attname<>'id'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=attrelid AND k.contype='p' AND attnum=ANY(k.conkey)) LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',t,c.attname);
    END LOOP;
  END LOOP;
END $$;
TRUNCATE public.trade_invoice_lines, public.trade_invoices, public.work_orders,
 public.group_work_orders, public.group_work_order_shares, public.work_order_customer_variations,
 public.trade_pay_settings, public.expense_receipts, public.job_commissions, public.trade_recurring_deductions CASCADE;
INSERT INTO public.trade_pay_settings(id,inclusive_super_from) VALUES(1,'2026-11-23');
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('trade_pay_inclusive_super_v1',true),('commission_from_job_only_v1',true)
 ON CONFLICT(flag_name) DO UPDATE SET enabled=EXCLUDED.enabled;
INSERT INTO public.users(id,name) SELECT md5('ZZTEST role '||n)::uuid,'ZZTEST trade role' FROM generate_series(1,5)n ON CONFLICT(id) DO NOTHING;
INSERT INTO public.jobs(id,status) VALUES(md5('ZZTEST job')::uuid,'accepted') ON CONFLICT(id) DO UPDATE SET status='accepted';
INSERT INTO public.work_orders(id,job_id,kind,agreed_labour_ex) VALUES(md5('ZZTEST work order')::uuid,md5('ZZTEST job')::uuid,'job',1120.00);
INSERT INTO public.trade_invoices(id,user_id,org_id,invoice_number,invoice_source,week_start,status,
 subtotal_ex,gross_earned,super_amount,net_pay,super_basis,invoice_kind,gst_on,gst)
SELECT md5('ZZTEST invoice '||n)::uuid,md5('ZZTEST role '||n)::uuid,md5('ZZTEST org')::uuid,
 'ZZTEST-'||n,'ZZTEST','2026-11-23','approved',1120,1120,120.00,1000.00,'inclusive_12_112_v1','standard',false,0
 FROM generate_series(1,1)n;
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,job_number,line_type,line_total_ex,job_work_order_id)
 VALUES(md5('ZZTEST line 1')::uuid,md5('ZZTEST invoice 1')::uuid,md5('ZZTEST job')::uuid,'ZZTEST-1','work order',1120,md5('ZZTEST work order')::uuid);
CREATE FUNCTION pg_temp.result(p_stage text DEFAULT 'before_xero') RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.trade_pay_run_check_v2('2026-11-25',1,md5('ZZTEST org')::uuid,p_stage)
$$;
CREATE FUNCTION pg_temp.has_stop(p_code text,p_invoice text DEFAULT 'ZZTEST-1',p_stage text DEFAULT 'before_xero')
 RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce(bool_or(i->'stops' @> jsonb_build_array(jsonb_build_object('code',p_code))),false)
 FROM jsonb_array_elements(pg_temp.result(p_stage)->'invoices')i WHERE i->>'invoice_number'=p_invoice
$$;
DO $$ DECLARE j jsonb; BEGIN
 j:=pg_temp.result();
 IF j->>'rule'<>'trade-pay-check-v2' OR (j#>>'{counts,clean}')::int<>1 THEN RAISE EXCEPTION 'ZZTEST exact work order must be clean: %',j; END IF;
 -- Money is numeric: earlier stack fixtures retain a two-decimal scale.
 IF (j#>>'{invoices,0,super_amount}')::numeric IS DISTINCT FROM 120
   OR (j#>>'{invoices,0,paid_to_you}')::numeric IS DISTINCT FROM 1000
   OR j#>>'{invoices,0,stage}' IS DISTINCT FROM 'before_xero'
   OR j#>'{invoices,0,pay_run_id}' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'ZZTEST pay coordinates: %',j; END IF;
 IF NOT pg_temp.has_stop('not_in_xero','ZZTEST-1','after_xero') THEN RAISE EXCEPTION 'ZZTEST after Xero must stop missing bill'; END IF;
 j:=public.trade_pay_run_check('2026-11-25',1,md5('ZZTEST org')::uuid);
 IF j->>'rule'<>'trade-pay-check-v1' OR NOT (j#>'{invoices,0,stops}' @> '[{"code":"not_in_xero"}]') THEN RAISE EXCEPTION 'ZZTEST v1 retains missing bill'; END IF;
 BEGIN PERFORM pg_temp.result('ZZTEST invalid'); RAISE EXCEPTION 'ZZTEST invalid stage accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM pg_temp.result(NULL); RAISE EXCEPTION 'ZZTEST null stage accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
UPDATE public.trade_invoice_lines SET line_total_ex=1120.01;
DO $$ BEGIN IF NOT pg_temp.has_stop('work_order_over_agreed') THEN RAISE EXCEPTION 'ZZTEST one cent over work order'; END IF; END $$;
-- An approved customer variation adds room; a draft does not.
INSERT INTO public.work_order_customer_variations(id,work_order_id,status,trade_allocation_ex)
 VALUES(md5('ZZTEST variation')::uuid,md5('ZZTEST work order')::uuid,'draft',0.01);
DO $$ BEGIN IF NOT pg_temp.has_stop('work_order_over_agreed') THEN RAISE EXCEPTION 'ZZTEST draft variation counted'; END IF; END $$;
UPDATE public.work_order_customer_variations SET status='approved';
DO $$ BEGIN IF pg_temp.has_stop('work_order_over_agreed') THEN RAISE EXCEPTION 'ZZTEST approved variation ignored'; END IF; END $$;
DELETE FROM public.work_order_customer_variations;
UPDATE public.trade_invoice_lines SET line_total_ex=1120;
UPDATE public.trade_invoices SET super_amount=134.40;
DO $$ BEGIN IF NOT pg_temp.has_stop('super_wrong') THEN RAISE EXCEPTION 'ZZTEST 12 percent is not 12 in 112'; END IF; END $$;
UPDATE public.trade_invoices SET super_amount=120,net_pay=1000.01;
DO $$ BEGIN IF NOT pg_temp.has_stop('super_wrong') THEN RAISE EXCEPTION 'ZZTEST net one cent wrong'; END IF; END $$;
UPDATE public.trade_invoices SET super_amount=NULL,net_pay=1000;
DO $$ BEGIN IF NOT pg_temp.has_stop('super_wrong') THEN RAISE EXCEPTION 'ZZTEST missing super must stop'; END IF; END $$;
UPDATE public.trade_invoices SET super_amount=120,super_basis=NULL;
DO $$ BEGIN IF NOT pg_temp.has_stop('super_not_inclusive') THEN RAISE EXCEPTION 'ZZTEST old rule after start'; END IF; END $$;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_pay_inclusive_super_v1';
DO $$ BEGIN IF pg_temp.has_stop('super_not_inclusive') THEN RAISE EXCEPTION 'ZZTEST off switch must keep old rule'; END IF; END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_pay_inclusive_super_v1';
UPDATE public.trade_invoices SET super_basis='inclusive_12_112_v1';
UPDATE public.trade_invoice_lines SET line_type='group share',job_work_order_id=NULL;
DO $$ BEGIN IF NOT pg_temp.has_stop('share_without_group') THEN RAISE EXCEPTION 'ZZTEST orphan share keeps v1 stop'; END IF; END $$;
UPDATE public.trade_invoice_lines SET line_type='work order',job_work_order_id=md5('ZZTEST work order')::uuid;
-- Exercise the optional amount-change function both absent and present. Load
-- the actual main migration inside this transaction, never a stand-in body.
DROP FUNCTION IF EXISTS public.work_order_amount_change_total(uuid);
UPDATE public.trade_invoice_lines SET line_total_ex=1120.01;
DO $$ BEGIN IF NOT pg_temp.has_stop('work_order_over_agreed') THEN RAISE EXCEPTION 'ZZTEST absent changes helper'; END IF; END $$;
\ir ../../../migrations/20261117171802_work_order_amount_changes.sql
INSERT INTO public.work_order_amount_changes(org_id,work_order_id,job_id,kind,from_ex,to_ex,delta_ex,reason,changed_by)
 VALUES(md5('ZZTEST org')::uuid,md5('ZZTEST work order')::uuid,md5('ZZTEST job')::uuid,'amount',1120,1120.01,0.01,'ZZTEST adjustment',md5('ZZTEST role 1')::uuid);
DO $$ BEGIN IF pg_temp.has_stop('work_order_over_agreed') THEN RAISE EXCEPTION 'ZZTEST approved amount change ignored'; END IF; END $$;
-- Return to the unchanged work-order amount for the pool fixtures.
ALTER TABLE public.work_order_amount_changes DISABLE TRIGGER USER;
DELETE FROM public.work_order_amount_changes WHERE job_id=md5('ZZTEST job')::uuid;
UPDATE public.trade_invoice_lines SET line_total_ex=1120;
-- Spec 23: three live shares equal the frozen pot, then one cent stops all three.
TRUNCATE public.trade_invoice_lines,public.trade_invoices CASCADE;
INSERT INTO public.group_work_orders(id,job_id,work_order_id,pay_basis,created_at,split_frozen_at)
 VALUES(md5('ZZTEST group')::uuid,md5('ZZTEST job')::uuid,md5('ZZTEST work order')::uuid,'inclusive_12_112_v1','2026-11-20','2026-11-24');
INSERT INTO public.group_work_order_shares(id,group_id,pot_ex)
 SELECT md5('ZZTEST share '||n)::uuid,md5('ZZTEST group')::uuid,1120 FROM generate_series(1,3)n;
INSERT INTO public.trade_invoices(id,user_id,org_id,invoice_number,invoice_source,week_start,status,
 subtotal_ex,gross_earned,super_amount,net_pay,super_basis,invoice_kind,gst_on,gst)
 SELECT md5('ZZTEST invoice '||n)::uuid,md5('ZZTEST role '||n)::uuid,md5('ZZTEST org')::uuid,'ZZTEST-'||n,'ZZTEST','2026-11-23','approved',
 amount,amount,round(amount*12/112,2),amount-round(amount*12/112,2),'inclusive_12_112_v1','standard',false,0
 FROM (VALUES(1,400.00),(2,400.00),(3,320.00))v(n,amount);
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,job_number,line_type,line_total_ex,job_work_order_id,group_share_id)
 SELECT md5('ZZTEST line '||n)::uuid,md5('ZZTEST invoice '||n)::uuid,md5('ZZTEST job')::uuid,'ZZTEST-1','group share',amount,
 md5('ZZTEST work order')::uuid,md5('ZZTEST share '||n)::uuid FROM (VALUES(1,400.00),(2,400.00),(3,320.00))v(n,amount);
DO $$ BEGIN IF (pg_temp.result()#>>'{counts,clean}')::int<>3 THEN RAISE EXCEPTION 'ZZTEST three shares at pot: %',pg_temp.result(); END IF; END $$;
UPDATE public.trade_invoice_lines SET line_total_ex=line_total_ex+0.01 WHERE id=md5('ZZTEST line 2')::uuid;
DO $$ DECLARE n int; BEGIN FOR n IN 1..3 LOOP
 IF NOT pg_temp.has_stop('group_shares_differ_from_pool','ZZTEST-'||n) OR NOT pg_temp.has_stop('work_order_over_agreed','ZZTEST-'||n)
 THEN RAISE EXCEPTION 'ZZTEST group cent must stop every invoice'; END IF;
 END LOOP; END $$;
UPDATE public.trade_invoice_lines SET line_total_ex=line_total_ex-0.02 WHERE id=md5('ZZTEST line 2')::uuid;
DO $$ DECLARE n int; BEGIN FOR n IN 1..3 LOOP IF NOT pg_temp.has_stop('group_shares_differ_from_pool','ZZTEST-'||n)
 THEN RAISE EXCEPTION 'ZZTEST short pool must stop every invoice'; END IF; END LOOP; END $$;
UPDATE public.trade_invoice_lines SET line_total_ex=line_total_ex+0.01 WHERE id=md5('ZZTEST line 2')::uuid;
UPDATE public.group_work_orders SET pay_basis='all_in_12_v2';
UPDATE public.trade_invoices SET super_basis='employer_12_v2';
DO $$ BEGIN IF pg_temp.has_stop('super_not_inclusive') THEN RAISE EXCEPTION 'ZZTEST pre-start group exemption'; END IF; END $$;
UPDATE public.group_work_orders SET created_at='2026-11-23';
DO $$ BEGIN IF NOT pg_temp.has_stop('super_not_inclusive') THEN RAISE EXCEPTION 'ZZTEST new group cannot use old exemption'; END IF; END $$;
-- Additional stops share one invoice so each reason remains independently observable.
UPDATE public.trade_invoices SET super_basis='inclusive_12_112_v1';
UPDATE public.trade_invoice_lines SET line_type='reimbursement',expense_receipt_id=md5('ZZTEST receipt')::uuid WHERE id=md5('ZZTEST line 1')::uuid;
DO $$ BEGIN IF NOT pg_temp.has_stop('reimbursement_no_receipt') OR NOT pg_temp.has_stop('reimbursement_account_not_set')
 THEN RAISE EXCEPTION 'ZZTEST reimbursement needs receipt and account'; END IF; END $$;
INSERT INTO public.expense_receipts(id,receipt_storage_path) VALUES(md5('ZZTEST receipt')::uuid,'ZZTEST/receipt.png');
UPDATE public.trade_pay_settings SET reimbursement_account_code='ZZTEST';
DO $$ BEGIN IF pg_temp.has_stop('reimbursement_no_receipt') OR pg_temp.has_stop('reimbursement_account_not_set')
 THEN RAISE EXCEPTION 'ZZTEST stored receipt and account not recognised'; END IF; END $$;
UPDATE public.trade_invoice_lines SET line_type='commission' WHERE id=md5('ZZTEST line 1')::uuid;
DO $$ BEGIN IF NOT pg_temp.has_stop('commission_no_record') THEN RAISE EXCEPTION 'ZZTEST commission needs named record'; END IF; END $$;
INSERT INTO public.job_commissions(id,job_id,state) VALUES(md5('ZZTEST commission')::uuid,md5('ZZTEST job')::uuid,'named');
UPDATE public.trade_invoice_lines SET line_type='work order',office_review_status='awaiting',not_job_work_type_id=md5('ZZTEST non job')::uuid WHERE id=md5('ZZTEST line 1')::uuid;
UPDATE public.work_orders SET kind='ZZTEST';
DO $$ BEGIN IF NOT pg_temp.has_stop('held_line_in_run') OR NOT pg_temp.has_stop('work_order_missing') OR NOT pg_temp.has_stop('not_job_work_account_not_set')
 THEN RAISE EXCEPTION 'ZZTEST held, missing work order and missing non-job account'; END IF; END $$;
INSERT INTO public.trade_recurring_deductions(id,kind) VALUES(md5('ZZTEST repayment')::uuid,'repayment');
UPDATE public.trade_invoices SET recurring_deduction_id=md5('ZZTEST repayment')::uuid,recurring_deduction_amount=1 WHERE invoice_number='ZZTEST-1';
DO $$ BEGIN IF NOT pg_temp.has_stop('repayment_account_not_set') THEN RAISE EXCEPTION 'ZZTEST repayment needs account'; END IF; END $$;
-- Office changes remain stops after Xero; pre-Xero deliberately leaves them out.
UPDATE public.trade_invoices SET xero_bill_id='ZZTEST',xero_bill_total=1000,xero_adjustment_lines='[{"kind":"unexplained","amount":0}]' WHERE invoice_number='ZZTEST-1';
DO $$ BEGIN IF NOT pg_temp.has_stop('xero_changed_by_hand','ZZTEST-1','after_xero') OR pg_temp.has_stop('xero_changed_by_hand')
 THEN RAISE EXCEPTION 'ZZTEST office change stage handling'; END IF; END $$;
-- Holding headers never enter either stage. A follow-on is never a duplicate week.
UPDATE public.trade_invoices SET invoice_kind='held' WHERE invoice_number='ZZTEST-3';
UPDATE public.trade_invoices SET invoice_kind='follow_on',user_id=md5('ZZTEST role 1')::uuid WHERE invoice_number='ZZTEST-2';
UPDATE public.trade_invoice_lines SET line_type='reimbursement' WHERE id=md5('ZZTEST line 2')::uuid;
DO $$ DECLARE j jsonb; BEGIN
 j:=pg_temp.result();
 IF (j#>>'{counts,invoices}')::int<>2 OR pg_temp.has_stop('second_invoice_same_week','ZZTEST-1') OR pg_temp.has_stop('second_invoice_same_week','ZZTEST-2')
 THEN RAISE EXCEPTION 'ZZTEST held or follow-on filtering'; END IF;
 IF pg_temp.result() IS DISTINCT FROM j THEN RAISE EXCEPTION 'ZZTEST refusal retry changed result'; END IF;
END $$;
DO $$ DECLARE f regprocedure:='public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure; BEGIN
 IF has_function_privilege('anon',f,'execute') OR has_function_privilege('authenticated',f,'execute')
 OR NOT has_function_privilege('service_role',f,'execute') OR (SELECT provolatile FROM pg_proc WHERE oid=f)<>'s'
 THEN RAISE EXCEPTION 'ZZTEST service-only read settings'; END IF;
END $$;
-- An unreadable required read fails loudly, never as a clean empty list.
DO $$ BEGIN
 BEGIN
   ALTER TABLE public.expense_receipts RENAME TO zztest_unreadable_receipts;
   PERFORM pg_temp.result();
   RAISE EXCEPTION 'ZZTEST unreadable receipt read returned an answer';
 EXCEPTION WHEN undefined_table THEN NULL;
 END;
END $$;
-- Older installations have neither optional invoice column. They still read.
ALTER TABLE public.trade_invoices DROP COLUMN invoice_kind CASCADE;
ALTER TABLE public.trade_invoices DROP COLUMN IF EXISTS pay_run_id CASCADE;
DO $$ BEGIN IF (pg_temp.result()#>>'{counts,invoices}')::int<>3 THEN RAISE EXCEPTION 'ZZTEST pre-kind schema'; END IF; END $$;
ROLLBACK;
\echo PASS P1-08.1 money and refusal contract
