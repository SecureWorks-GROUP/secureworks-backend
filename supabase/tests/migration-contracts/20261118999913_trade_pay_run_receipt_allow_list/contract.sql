-- SEC-465 allow-list contract. Every value, id and word is made up (ZZTEST).
-- The pay run check passes a pay-back line only when its receipt is approved or
-- pushed_to_xero, or pending on a line the office approved (ruling B, 23:46): the push's
-- allow-list, with the push's three reasons; nothing else moves.
BEGIN;
SET LOCAL statement_timeout = '120s';
-- Rule 17: re-apply what this contract asserts on (twice: the guard takes its own body).
\ir ../../../migrations/20261118999913_trade_pay_run_receipt_allow_list.sql
\ir ../../../migrations/20261118999913_trade_pay_run_receipt_allow_list.sql

CREATE FUNCTION pg_temp.zz_assert(ok boolean, words text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', words; END IF;
END $$;

SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'daee6c551634e062577f1c7f45950ae8',
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
\ir ../../../migrations/20261118999913_trade_pay_run_receipt_allow_list.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.trade_pay_run_check_v2(p_as_of date, p_weeks integer, p_org_id uuid, p_stage text DEFAULT 'after_xero')
RETURNS jsonb LANGUAGE sql STABLE AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../rollbacks/20261118999913_trade_pay_run_receipt_allow_list_down.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_apply' LIKE '%trade_pay_run_check_v2: Rule 15, another body is installed%',
  'a re-apply must refuse another body: ' || :'collide_apply');
SELECT pg_temp.zz_assert(:'collide_down' LIKE '%trade_pay_run_check_v2 rollback: Rule 15, another body is installed%',
  'the rollback must refuse another body: ' || :'collide_down');
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'daee6c551634e062577f1c7f45950ae8',
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
-- The receipt stop codes on one invoice, in name order.
CREATE FUNCTION pg_temp.receipt_stops(p_number text) RETURNS text[] LANGUAGE sql AS $$
 SELECT coalesce(array_agg(s->>'code' ORDER BY s->>'code'), ARRAY[]::text[])
 FROM jsonb_array_elements(pg_temp.inv(p_number)->'stops') s
 WHERE s->>'code' IN ('reimbursement_queried_or_rejected','reimbursement_not_booked_unconfirmed',
                      'reimbursement_receipt_not_approved','reimbursement_no_receipt')
$$;

-- Approved, unmarked receipts: both invoices are clean, and the answer is
-- 20261118194500's answer exactly (its body stood back up inside a savepoint).
SELECT pg_temp.zz_assert((pg_temp.inv('ZZTEST-NB-1')->>'verdict') = 'clean'
  AND (pg_temp.inv('ZZTEST-NB-2')->>'verdict') = 'clean', 'approved fixtures must be clean: ' || pg_temp.result()::text);
SELECT pg_temp.result()::text AS zz_answer \gset
SAVEPOINT zz_main;
\ir ../../../rollbacks/20261118999913_trade_pay_run_receipt_allow_list_down.sql
SELECT pg_temp.result()::text AS zz_main_answer \gset
UPDATE public.expense_receipts SET status = 'queried' WHERE id = md5('ZZTEST nb receipt 1')::uuid;
SELECT pg_temp.result()::text AS zz_main_queried \gset
ROLLBACK TO SAVEPOINT zz_main;
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'daee6c551634e062577f1c7f45950ae8',
  'own body back after the savepoint');
SELECT pg_temp.zz_assert(:'zz_answer'::jsonb = :'zz_main_answer'::jsonb,
  'with every receipt approved the answer must equal 20261118194500''s');
-- The earlier body passed an unmarked queried receipt as clean: the gap this closes.
SELECT pg_temp.zz_assert((SELECT i->>'verdict' FROM jsonb_array_elements(:'zz_main_queried'::jsonb->'invoices') i
       WHERE i->>'invoice_number' = 'ZZTEST-NB-1') = 'clean', 'earlier body passed a queried receipt as clean');

-- The matrix (ruling B, 23:46). The same rows are in trade_pay_run_push_test.ts ("same stops"): the
-- invoice is stopped exactly where the push refuses, with the matching reasons.
CREATE TEMP TABLE zz_matrix(status text, marked boolean, line_approved boolean, want text[]) ON COMMIT DROP;
INSERT INTO zz_matrix VALUES
 -- passes: approved or pushed_to_xero, marked or not, line approved or not
 ('approved',false,false,'{}'),('APPROVED',false,false,'{}'),('pushed_to_xero',false,false,'{}'),
 ('Pushed_To_Xero',false,false,'{}'),('approved',true,false,'{}'),('pushed_to_xero',true,false,'{}'),
 ('approved',false,true,'{}'),
 -- passes (ruling B): the office approved the line and the receipt is pending or pending_extraction
 ('pending',false,true,'{}'),('pending_extraction',false,true,'{}'),('PENDING',false,true,'{}'),
 -- stops: not approved, the line not approved either; an unknown or new status even with the line approved
 ('pending',false,false,'{reimbursement_receipt_not_approved}'),
 ('pending_extraction',false,false,'{reimbursement_receipt_not_approved}'),
 ('zz_new_status',false,false,'{reimbursement_receipt_not_approved}'),
 ('zz_new_status',false,true,'{reimbursement_receipt_not_approved}'),
 (' approved ',false,false,'{reimbursement_receipt_not_approved}'),
 (' pending ',false,true,'{reimbursement_receipt_not_approved}'),
 ('',false,false,'{reimbursement_receipt_not_approved}'),
 ('',false,true,'{reimbursement_receipt_not_approved}'),
 (NULL,false,false,'{reimbursement_receipt_not_approved}'),
 (NULL,false,true,'{reimbursement_receipt_not_approved}'),
 -- stops: queried or rejected, whatever the line
 ('queried',false,false,'{reimbursement_queried_or_rejected}'),
 ('rejected',false,false,'{reimbursement_queried_or_rejected}'),
 ('Queried',false,false,'{reimbursement_queried_or_rejected}'),
 (' REJECTED ',false,false,'{reimbursement_queried_or_rejected}'),
 ('queried',false,true,'{reimbursement_queried_or_rejected}'),
 ('rejected',false,true,'{reimbursement_queried_or_rejected}'),
 -- stops: marked not booked and unconfirmed, whatever the line
 ('pending',true,false,'{reimbursement_not_booked_unconfirmed}'),
 ('pending',true,true,'{reimbursement_not_booked_unconfirmed}'),
 ('pending_extraction',true,true,'{reimbursement_not_booked_unconfirmed}'),
 ('zz_new_status',true,false,'{reimbursement_not_booked_unconfirmed}'),
 (NULL,true,false,'{reimbursement_not_booked_unconfirmed}'),
 ('queried',true,false,'{reimbursement_not_booked_unconfirmed,reimbursement_queried_or_rejected}'),
 ('rejected',true,true,'{reimbursement_not_booked_unconfirmed,reimbursement_queried_or_rejected}');
DO $$ DECLARE m record; got text[]; BEGIN
  FOR m IN SELECT * FROM zz_matrix LOOP
    UPDATE public.expense_receipts SET status = m.status,
      unbooked_job_id = CASE WHEN m.marked THEN md5('ZZTEST nb other job')::uuid END
     WHERE id = md5('ZZTEST nb receipt 1')::uuid;
    UPDATE public.trade_invoice_lines SET office_review_status = CASE WHEN m.line_approved THEN 'approved' END
     WHERE id = md5('ZZTEST nb pay back 1')::uuid;
    got := pg_temp.receipt_stops('ZZTEST-NB-1');
    PERFORM pg_temp.zz_assert(got = m.want AND (pg_temp.inv('ZZTEST-NB-1')->>'verdict')
      = CASE WHEN cardinality(m.want) = 0 THEN 'clean' ELSE 'stopped' END,
      format('status %L marked %s line approved %s: want %s, got %s', m.status, m.marked, m.line_approved, m.want, got));
    PERFORM pg_temp.zz_assert(pg_temp.receipt_stops('ZZTEST-NB-2') = ARRAY[]::text[]
      AND (pg_temp.inv('ZZTEST-NB-2')->>'verdict') = 'clean', 'the other invoice stays clean');
  END LOOP;
END $$;
-- Only the office's approval of the line passes a pending receipt: a line still
-- awaiting review, queried or rejected does not (and keeps its own line stop).
DO $$ DECLARE r text; BEGIN
  UPDATE public.expense_receipts SET status = 'pending', unbooked_job_id = NULL WHERE id = md5('ZZTEST nb receipt 1')::uuid;
  FOREACH r IN ARRAY ARRAY['awaiting','queried','rejected','APPROVED'] LOOP
    UPDATE public.trade_invoice_lines SET office_review_status = r WHERE id = md5('ZZTEST nb pay back 1')::uuid;
    PERFORM pg_temp.zz_assert(pg_temp.receipt_stops('ZZTEST-NB-1') = ARRAY['reimbursement_receipt_not_approved'],
      'a pending receipt on a line at review ' || r || ' must stop');
  END LOOP;
  UPDATE public.trade_invoice_lines SET office_review_status = NULL WHERE id = md5('ZZTEST nb pay back 1')::uuid;
END $$;
-- The words, exactly, one stop per invoice for two pay-back lines on one invoice.
UPDATE public.expense_receipts SET status = 'pending', unbooked_job_id = NULL WHERE id = md5('ZZTEST nb receipt 1')::uuid;
SELECT pg_temp.zz_assert((SELECT s->>'words' FROM jsonb_array_elements(pg_temp.inv('ZZTEST-NB-1')->'stops') s
  WHERE s->>'code' = 'reimbursement_receipt_not_approved')
  = 'A pay-back receipt on this invoice is not approved by the office yet.', 'not approved words');
UPDATE public.expense_receipts SET status = 'rejected' WHERE id = md5('ZZTEST nb receipt 1')::uuid;
SELECT pg_temp.zz_assert((SELECT s->>'words' FROM jsonb_array_elements(pg_temp.inv('ZZTEST-NB-1')->'stops') s
  WHERE s->>'code' = 'reimbursement_queried_or_rejected')
  = 'The office has queried or rejected a pay-back receipt on this invoice.', 'queried or rejected words');
INSERT INTO public.expense_receipts(id,receipt_storage_path,status) VALUES(md5('ZZTEST nb receipt 3')::uuid,'ZZTEST/receipt.png','queried');
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,job_number,line_type,line_total_ex,expense_receipt_id)
VALUES(md5('ZZTEST nb pay back 3')::uuid,md5('ZZTEST nb invoice 1')::uuid,md5('ZZTEST nb other job')::uuid,'ZZTEST-NB','reimbursement',0,
       md5('ZZTEST nb receipt 3')::uuid);
SELECT pg_temp.zz_assert(pg_temp.receipt_stops('ZZTEST-NB-1') = ARRAY['reimbursement_queried_or_rejected'], 'one stop per invoice');
DELETE FROM public.trade_invoice_lines WHERE id = md5('ZZTEST nb pay back 3')::uuid;
SELECT pg_temp.zz_assert((pg_temp.result()#>>'{counts,clean}')::int = 1, 'one clean invoice counted');

-- A pay-back line whose receipt row is missing, or with no receipt at all: only the
-- existing no-receipt stop (the push refuses both as not approved).
UPDATE public.trade_invoice_lines SET expense_receipt_id = md5('ZZTEST nb missing')::uuid, office_review_status = 'approved'
 WHERE id = md5('ZZTEST nb pay back 1')::uuid;
SELECT pg_temp.zz_assert(pg_temp.receipt_stops('ZZTEST-NB-1') = ARRAY['reimbursement_no_receipt']
  AND (pg_temp.inv('ZZTEST-NB-1')->>'verdict') = 'stopped', 'missing (deleted) receipt row stops, even with the line approved');
UPDATE public.trade_invoice_lines SET expense_receipt_id = NULL WHERE id = md5('ZZTEST nb pay back 1')::uuid;
SELECT pg_temp.zz_assert(pg_temp.receipt_stops('ZZTEST-NB-1') = ARRAY['reimbursement_no_receipt'], 'no receipt id');
-- Only a pay-back line reads its receipt: a rejected receipt on another kind of line does not.
UPDATE public.trade_invoice_lines SET expense_receipt_id = md5('ZZTEST nb receipt 1')::uuid, line_type = 'work order'
 WHERE id = md5('ZZTEST nb pay back 1')::uuid;
SELECT pg_temp.zz_assert(pg_temp.receipt_stops('ZZTEST-NB-1') = ARRAY[]::text[], 'a non pay-back line must not read the receipt');
\echo 'PASS: SEC-465 allow-list the pay run check passes a pay-back receipt approved or pushed_to_xero, or pending on a line the office approved; stops every other, with the push''s reasons; nothing else moves.'

-- Round trip: the rollback gives back the earlier body, and a re-apply installs this one.
\ir ../../../rollbacks/20261118999913_trade_pay_run_receipt_allow_list_down.sql
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'c6c1f4da1fb43e2fb781b884502a7b5d',
  'the rollback must give back 20261118194500''s body');
\ir ../../../migrations/20261118999913_trade_pay_run_receipt_allow_list.sql
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'daee6c551634e062577f1c7f45950ae8',
  'the re-apply must install this body');
ROLLBACK;
\echo 'PASS: SEC-465 allow-list Rule 15 guards and rollback round trip.'
