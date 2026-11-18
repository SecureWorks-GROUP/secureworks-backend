-- cl-payrun-v1-followups (2) contract. Every value, id and word is made up (ZZTEST).
-- The pay run check refuses a pay-back line whose receipt is marked not booked on
-- its job and not yet confirmed by the office; nothing else in its answer moves.
BEGIN;
SET LOCAL statement_timeout = '120s';
-- Rule 17: re-apply what this contract asserts on (twice: the guard takes its own body).
\ir ../../../migrations/20261118194500_trade_pay_run_receipt_not_booked.sql
\ir ../../../migrations/20261118194500_trade_pay_run_receipt_not_booked.sql

CREATE FUNCTION pg_temp.zz_assert(ok boolean, words text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', words; END IF;
END $$;

SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'c6c1f4da1fb43e2fb781b884502a7b5d',
  'own body installed after two runs');
SELECT pg_temp.zz_assert(has_function_privilege('service_role', 'public.trade_pay_run_check_v2(date,integer,uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.trade_pay_run_check_v2(date,integer,uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.trade_pay_run_check_v2(date,integer,uuid,text)', 'EXECUTE')
  AND (SELECT provolatile = 's' FROM pg_proc WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure),
  'service role only, stable read');
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1' AND enabled),
  'the pay run switch stays off');

-- Rule 15: another body is never replaced by a re-apply, nor by the rollback.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.trade_pay_run_check_v2(p_as_of date, p_weeks integer, p_org_id uuid, p_stage text DEFAULT 'after_xero')
RETURNS jsonb LANGUAGE sql STABLE AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../migrations/20261118194500_trade_pay_run_receipt_not_booked.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.trade_pay_run_check_v2(p_as_of date, p_weeks integer, p_org_id uuid, p_stage text DEFAULT 'after_xero')
RETURNS jsonb LANGUAGE sql STABLE AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../rollbacks/20261118194500_trade_pay_run_receipt_not_booked_down.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_apply' LIKE '%trade_pay_run_check_v2: Rule 15, another body is installed%',
  'a re-apply must refuse another body: ' || :'collide_apply');
SELECT pg_temp.zz_assert(:'collide_down' LIKE '%trade_pay_run_check_v2 rollback: Rule 15, another body is installed%',
  'the rollback must refuse another body: ' || :'collide_down');
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'c6c1f4da1fb43e2fb781b884502a7b5d',
  'own body still installed after the refusals');

-- Fixtures (rolled back). Unrelated write guards are set aside only inside this transaction.
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
INSERT INTO public.trade_pay_settings(id,inclusive_super_from,reimbursement_account_code) VALUES(1,'2026-11-23','ZZTEST');
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('trade_pay_inclusive_super_v1',true)
 ON CONFLICT(flag_name) DO UPDATE SET enabled=EXCLUDED.enabled;
INSERT INTO public.users(id,name) SELECT md5('ZZTEST nb role '||n)::uuid,'ZZTEST trade role' FROM generate_series(1,2)n ON CONFLICT(id) DO NOTHING;
INSERT INTO public.jobs(id,status) SELECT md5('ZZTEST nb job '||n)::uuid,'accepted' FROM generate_series(1,2)n
 ON CONFLICT(id) DO UPDATE SET status='accepted';
INSERT INTO public.jobs(id,status) VALUES(md5('ZZTEST nb other job')::uuid,'accepted') ON CONFLICT(id) DO UPDATE SET status='accepted';
INSERT INTO public.work_orders(id,job_id,kind,agreed_labour_ex)
SELECT md5('ZZTEST nb work order '||n)::uuid,md5('ZZTEST nb job '||n)::uuid,'job',1120.00 FROM generate_series(1,2)n;
-- Two invoices, each a work order line and a pay-back line on its own receipt.
INSERT INTO public.trade_invoices(id,user_id,org_id,invoice_number,invoice_source,week_start,status,
 subtotal_ex,gross_earned,super_amount,net_pay,super_basis,invoice_kind,gst_on,gst)
SELECT md5('ZZTEST nb invoice '||n)::uuid,md5('ZZTEST nb role '||n)::uuid,md5('ZZTEST nb org')::uuid,
 'ZZTEST-NB-'||n,'ZZTEST','2026-11-23','approved',1120,1120,120.00,1000.00,'inclusive_12_112_v1','standard',false,0
 FROM generate_series(1,2)n;
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,job_number,line_type,line_total_ex,job_work_order_id,expense_receipt_id)
SELECT md5('ZZTEST nb work line '||n)::uuid,md5('ZZTEST nb invoice '||n)::uuid,md5('ZZTEST nb job '||n)::uuid,'ZZTEST-NB-J'||n,'work order',1120,
       md5('ZZTEST nb work order '||n)::uuid,NULL FROM generate_series(1,2)n
UNION ALL
SELECT md5('ZZTEST nb pay back '||n)::uuid,md5('ZZTEST nb invoice '||n)::uuid,md5('ZZTEST nb other job')::uuid,'ZZTEST-NB','reimbursement',0,
       NULL,md5('ZZTEST nb receipt '||n)::uuid FROM generate_series(1,2)n;
INSERT INTO public.expense_receipts(id,receipt_storage_path,status,unbooked_job_id)
SELECT md5('ZZTEST nb receipt '||n)::uuid,'ZZTEST/receipt.png','approved',NULL FROM generate_series(1,2)n;

CREATE FUNCTION pg_temp.result() RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.trade_pay_run_check_v2('2026-11-25',1,md5('ZZTEST nb org')::uuid,'before_xero')
$$;
CREATE FUNCTION pg_temp.inv(p_number text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT i FROM jsonb_array_elements(pg_temp.result()->'invoices') i WHERE i->>'invoice_number' = p_number
$$;
CREATE FUNCTION pg_temp.has_stop(p_number text) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce(pg_temp.inv(p_number)->'stops' @> '[{"code":"reimbursement_not_booked_unconfirmed"}]', false)
$$;

-- Unmarked receipts: both invoices are clean, and the answer is 20261118163000's
-- answer exactly (the rollback stands that body back up inside a savepoint).
SELECT pg_temp.zz_assert((pg_temp.inv('ZZTEST-NB-1')->>'verdict') = 'clean'
  AND (pg_temp.inv('ZZTEST-NB-2')->>'verdict') = 'clean', 'unmarked fixtures must be clean: ' || pg_temp.result()::text);
SELECT pg_temp.result()::text AS zz_answer \gset
SAVEPOINT zz_main;
\ir ../../../rollbacks/20261118194500_trade_pay_run_receipt_not_booked_down.sql
SELECT pg_temp.result()::text AS zz_main_answer \gset
UPDATE public.expense_receipts SET unbooked_job_id = md5('ZZTEST nb other job')::uuid, status = 'pending'
 WHERE id = md5('ZZTEST nb receipt 1')::uuid;
SELECT pg_temp.result()::text AS zz_main_marked \gset
ROLLBACK TO SAVEPOINT zz_main;
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'c6c1f4da1fb43e2fb781b884502a7b5d',
  'own body back after the savepoint');
SELECT pg_temp.zz_assert(:'zz_answer'::jsonb = :'zz_main_answer'::jsonb,
  'with no marked receipt the answer must equal 20261118163000''s');
-- The earlier body never stopped a marked receipt: this is the gap the stop closes.
SELECT pg_temp.zz_assert(NOT (:'zz_main_marked'::jsonb::text LIKE '%reimbursement_not_booked_unconfirmed%')
  AND (SELECT i->>'verdict' FROM jsonb_array_elements(:'zz_main_marked'::jsonb->'invoices') i
       WHERE i->>'invoice_number' = 'ZZTEST-NB-1') = 'clean', 'earlier body passed a marked receipt as clean');

-- Marked and not confirmed: every status that is not approved or pushed_to_xero stops.
UPDATE public.expense_receipts SET unbooked_job_id = md5('ZZTEST nb other job')::uuid
 WHERE id = md5('ZZTEST nb receipt 1')::uuid;
DO $$ DECLARE s text; BEGIN
  FOREACH s IN ARRAY ARRAY['pending','pending_approval','queried','rejected','Queried',''] LOOP
    UPDATE public.expense_receipts SET status = s WHERE id = md5('ZZTEST nb receipt 1')::uuid;
    PERFORM pg_temp.zz_assert(pg_temp.has_stop('ZZTEST-NB-1') AND (pg_temp.inv('ZZTEST-NB-1')->>'verdict') = 'stopped',
      'a marked receipt at status "' || s || '" must stop its invoice');
  END LOOP;
  UPDATE public.expense_receipts SET status = NULL WHERE id = md5('ZZTEST nb receipt 1')::uuid;
  PERFORM pg_temp.zz_assert(pg_temp.has_stop('ZZTEST-NB-1'), 'a marked receipt with no status must stop its invoice');
END $$;
-- The words, exactly, and the other invoice is untouched.
SELECT pg_temp.zz_assert((SELECT s->>'words' FROM jsonb_array_elements(pg_temp.inv('ZZTEST-NB-1')->'stops') s
  WHERE s->>'code' = 'reimbursement_not_booked_unconfirmed')
  = 'A pay-back receipt is from someone not booked on its job, and the office has not confirmed it yet.', 'stop words');
SELECT pg_temp.zz_assert((SELECT count(*) = 1 FROM jsonb_array_elements(pg_temp.inv('ZZTEST-NB-1')->'stops') s
  WHERE s->>'code' = 'reimbursement_not_booked_unconfirmed'), 'one stop per invoice');
SELECT pg_temp.zz_assert(NOT pg_temp.has_stop('ZZTEST-NB-2') AND (pg_temp.inv('ZZTEST-NB-2')->>'verdict') = 'clean',
  'an invoice with an unmarked receipt stays clean');
SELECT pg_temp.zz_assert((pg_temp.result()#>>'{counts,clean}')::int = 1, 'one clean invoice counted');

-- The office's confirm (approved, or pushed to Xero after it) clears it, whatever the case.
DO $$ DECLARE s text; BEGIN
  FOREACH s IN ARRAY ARRAY['approved','APPROVED','pushed_to_xero'] LOOP
    UPDATE public.expense_receipts SET status = s WHERE id = md5('ZZTEST nb receipt 1')::uuid;
    PERFORM pg_temp.zz_assert(NOT pg_temp.has_stop('ZZTEST-NB-1') AND (pg_temp.inv('ZZTEST-NB-1')->>'verdict') = 'clean',
      'a confirmed receipt at status "' || s || '" must not stop');
  END LOOP;
END $$;

-- Only a pay-back line reads its receipt's mark: a marked, unconfirmed receipt on
-- another kind of line is left to that line's own checks.
UPDATE public.expense_receipts SET status = 'pending' WHERE id = md5('ZZTEST nb receipt 1')::uuid;
UPDATE public.trade_invoice_lines SET line_type = 'work order' WHERE id = md5('ZZTEST nb pay back 1')::uuid;
SELECT pg_temp.zz_assert(NOT pg_temp.has_stop('ZZTEST-NB-1'), 'a non pay-back line must not read the mark');
-- A pay-back line with no receipt row: only the existing no-receipt stop fires.
UPDATE public.trade_invoice_lines SET line_type = 'reimbursement', expense_receipt_id = md5('ZZTEST nb missing')::uuid
 WHERE id = md5('ZZTEST nb pay back 1')::uuid;
SELECT pg_temp.zz_assert(NOT pg_temp.has_stop('ZZTEST-NB-1')
  AND pg_temp.inv('ZZTEST-NB-1')->'stops' @> '[{"code":"reimbursement_no_receipt"}]', 'missing receipt: the existing stop only');

-- The approval leaves a stopped invoice out: a press whose only invoice is stopped
-- by this check is refused and writes nothing.
UPDATE public.trade_invoice_lines SET expense_receipt_id = md5('ZZTEST nb receipt 1')::uuid
 WHERE id = md5('ZZTEST nb pay back 1')::uuid;
SELECT pg_temp.zz_assert(pg_temp.has_stop('ZZTEST-NB-1'), 'restored marked line stops');
\echo 'PASS: cl-payrun-v1-followups the pay run check stops a pay-back line whose receipt is marked not booked and not confirmed; the confirm clears it; nothing else moves.'

-- Round trip: the rollback gives back the earlier body, and a re-apply installs this one.
\ir ../../../rollbacks/20261118194500_trade_pay_run_receipt_not_booked_down.sql
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = '7bf3b7dbccc9c5ef8656b6c43e3e9a0b',
  'the rollback must give back 20261118163000''s body');
\ir ../../../migrations/20261118194500_trade_pay_run_receipt_not_booked.sql
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'c6c1f4da1fb43e2fb781b884502a7b5d',
  'the re-apply must install this body');
ROLLBACK;
\echo 'PASS: cl-payrun-v1-followups Rule 15 guards and rollback round trip.'
